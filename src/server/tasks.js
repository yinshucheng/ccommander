import { getTasks, getSessions, getHistory, persist } from './store.js'
import { groupQueue, pickCurrent, shouldAutoReviveAll } from './scheduler.js'
import { broadcast } from './bus.js'
import { renderCommand } from './config.js'

let lastCurrentId = null

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`
}

// 拼装 current 任务 + 它关联的 session 详情（供面板展示命令/目录/上次输出）
export function buildCurrent() {
  const { tasks } = getTasks()
  const task = pickCurrent(tasks)
  if (!task) return null
  const { sessions } = getSessions()
  const linked = (task.sessions || [])
    .map((sid) => sessions.find((s) => s.id === sid))
    .filter(Boolean)
  return { ...task, sessionDetails: linked }
}

export function buildQueue() {
  const { tasks } = getTasks()
  const { sessions } = getSessions()
  const groups = groupQueue(tasks)
  const attach = (t) => {
    if (!t) return t
    const linked = (t.sessions || [])
      .map((sid) => sessions.find((s) => s.id === sid))
      .filter(Boolean)
    return { ...t, sessionDetails: linked }
  }
  // 跳过聚合：当前在队列里(current+waiting+deferred)累计被跳过的总次数与涉及任务数，
  // 供面板展示「这段时间跳过了多少」。
  const inQueue = [groups.current, ...groups.waiting, ...groups.deferred].filter(Boolean)
  const skippedTotal = inQueue.reduce((n, t) => n + (t.skipCount || 0), 0)
  const skippedTasks = inQueue.filter((t) => (t.skipCount || 0) > 0).length

  return {
    current: attach(groups.current),
    waiting: groups.waiting.map(attach),
    deferred: groups.deferred.map(attach),
    done: groups.done.map(attach),
    skippedTotal,
    skippedTasks,
  }
}

// 全局视角：多少 session 在进行、各状态计数、谁等得最久
export function buildOverview() {
  const { sessions } = getSessions()
  const now = Date.now()
  const active = sessions.filter((s) => !s.dismissed)
  const byState = { waiting: 0, running: 0, idle: 0, completed: 0 }
  for (const s of active) {
    const st = s.liveState || 'idle'
    byState[st] = (byState[st] || 0) + 1
  }
  // 等待时长：以 lastEventAt 为基准（多久没动静了）
  const waits = active
    .map((s) => ({
      claudeSessionId: s.claudeSessionId,
      projectName: s.projectName,
      label: s.label,
      liveState: s.liveState,
      idleMs: now - (s.lastEventAt || s.lastActiveAt || now),
    }))
    .sort((a, b) => b.idleMs - a.idleMs)

  return {
    total: active.length,
    byState,
    // 等待你处理（waiting）的，按等待时长降序
    waitingLongest: waits.filter((w) => w.liveState === 'waiting').slice(0, 8),
    // 所有会话里最久没动静的
    stalest: waits.slice(0, 8),
  }
}

// 任意会改变队列的操作后调用：持久化 + 广播；若 current 变了额外推 new_current
// 队列空了(只剩被推迟的任务)就把它们全部唤回:清掉 deferUntil,重新入队。
// 返回是否发生了变更。在 notifyChange/tickDefer 计算队列前调用,保证「队列一空立即复活」。
function autoReviveIfEmpty() {
  const { tasks } = getTasks()
  if (!shouldAutoReviveAll(tasks)) return false
  for (const t of tasks) {
    if (t.deferUntil && t.status !== 'done' && t.status !== 'skipped') t.deferUntil = null
  }
  return true
}

export function notifyChange() {
  autoReviveIfEmpty()
  persist('tasks')
  const queue = buildQueue()
  broadcast({ type: 'queue_updated', queue })
  const current = queue.current
  const curId = current?.id ?? null
  if (curId !== lastCurrentId) {
    lastCurrentId = curId
    broadcast({ type: 'new_current', task: current })
  }
}

export function createTask(input = {}) {
  const data = getTasks()
  const now = Date.now()
  const task = {
    id: genId('t'),
    title: input.title ?? null,
    context: input.context ?? null,
    priority: input.priority || 'P2',
    type: input.type ?? null,
    status: 'queued',
    sessions: [],
    createdAt: now,
    queuedAt: now,
    startedAt: null,
    completedAt: null,
    skipCount: 0,
    deferUntil: null,
    notes: null,
  }

  // 内联创建/绑定 session（CLI 传 cwd/cmd/session-id 时）
  if (input.workingDir || input.command || input.sessionId) {
    const sessions = getSessions()
    const session = {
      id: genId('s'),
      label: input.sessionLabel ?? null,
      agentType: input.agentType || 'claude-code',
      sessionId: input.sessionId ?? null,
      workingDir: input.workingDir || process.cwd(),
      command: input.command || (input.sessionId ? renderCommand(input.sessionId, input.workingDir) : ''),
      status: 'waiting',
      taskId: task.id,
      lastOutput: input.lastOutput ?? null,
      createdAt: now,
      lastActiveAt: now,
    }
    sessions.sessions.push(session)
    persist('sessions')
    task.sessions.push(session.id)
  }

  data.tasks.push(task)
  notifyChange()
  return task
}

// ── 会话发现：hook 事件 / 扫描 → upsert session → 自动建/更新隐式 task ──
//
// rec: { claudeSessionId, projectName, projectRoot, gitBranch, summary,
//        liveState: 'running'|'waiting'|'idle'|'completed', source: 'hook'|'scan',
//        eventAt }
// 返回是否发生了「值得让面板冒出来」的变化（waiting/completed 等）
const LIVE_RANK = { hook: 2, scan: 1 }

// ── 复活规则（纯函数，根因层，可单测）──
// 已处理完（done）/已移除（dismissed）的会话，只在「收到该会话新的 waiting hook 事件」
// 时才复活——说明又有新的事要你处理。scan 的近似态（idle/waiting）不得把已处理的
// 任务/会话打回队列，否则点完成后会被周期扫描反复复活（问题 1 的根因）。
export function shouldRevive(rec) {
  return rec?.liveState === 'waiting' && rec?.source === 'hook'
}

// ── 空会话判定（纯函数）──
// 无真实用户消息（transcript 全是注入/系统/空）的会话不该建隐式 task、不该入队。
// rec.hasRealUserMsg 由来源（scanner/events）每次带上 → 动态判定：后续该会话有了
// 真实用户消息，下一轮即冒出来。缺省 undefined 视为「未知 → 不过滤」（向后兼容旧来源）。
export function isEmptySession(rec) {
  return rec?.hasRealUserMsg === false
}

// ── stale running 纠正（纯函数，根因层，可单测）──
// 常规下 hook 态优先于 scan（LIVE_RANK），scan 不能把 hook 的精确态覆盖回近似态。
// 但有个空档：`--resume` 一个本已 idle 的旧会话会触发 SessionStart→running(hook)，
// 之后若没有真实 turn，就永远等不到 Stop/Notification 来收尾，会话永久卡在 running。
// 关键洞察:scanner 的 classify() 只在 jsonl 静默 >180s 后才返回非 running 的终态——
// 真正在跑的会话会持续写 jsonl,scan 也必然返回 running。所以「当前是 hook running、
// 而 scan 报了终态(waiting/idle/completed)」本身就是「这个 hook running 已过期」的铁证,
// 此时破例允许 scan 纠正它。其余情况一律维持 hook 优先。
export function scanOverridesStaleRunning(rec, session) {
  return (
    rec?.source === 'scan' &&
    !!rec?.liveState &&
    rec.liveState !== 'running' && // scan 报了终态 = jsonl 已静默 → 证明没在跑
    session?.liveState === 'running' &&
    session?.source === 'hook'
  )
}

export function upsertFromAgent(rec) {
  if (!rec || !rec.claudeSessionId) return false
  const now = rec.eventAt || Date.now()
  const sessStore = getSessions()
  const taskStore = getTasks()

  let session = sessStore.sessions.find((s) => s.claudeSessionId === rec.claudeSessionId)
  let isNew = false

  if (!session) {
    session = {
      id: genId('s'),
      label: rec.summary || null,
      agentType: 'claude-code',
      claudeSessionId: rec.claudeSessionId,
      sessionId: rec.claudeSessionId,
      workingDir: rec.projectRoot || rec.cwd || '',
      command: renderCommand(rec.claudeSessionId, rec.projectRoot || rec.cwd || ''),
      source: rec.source || 'scan',
      projectName: rec.projectName || null,
      projectRoot: rec.projectRoot || null,
      gitBranch: rec.gitBranch || null,
      liveState: rec.liveState || 'idle',
      status: rec.liveState === 'waiting' ? 'waiting' : 'running',
      taskId: null,
      dismissed: false,
      lastOutput: rec.summary || null,
      lastEventAt: now,
      createdAt: now,
      lastActiveAt: now,
    }
    sessStore.sessions.push(session)
    isNew = true
  } else {
    // hook 数据优先于 scan：scan 不能把 hook 设的精确态覆盖回近似态。
    // 例外：stale running——scan 可纠正一个永远等不到收尾事件的 hook running（见 scanOverridesStaleRunning）。
    const incomingRank = LIVE_RANK[rec.source || 'scan'] || 1
    const currentRank = LIVE_RANK[session.source || 'scan'] || 1
    if (
      incomingRank >= currentRank ||
      rec.source === 'hook' ||
      scanOverridesStaleRunning(rec, session)
    ) {
      if (rec.liveState) session.liveState = rec.liveState
      session.source = rec.source || session.source
    }
    if (rec.summary) session.label = rec.summary
    if (rec.projectName) session.projectName = rec.projectName
    if (rec.projectRoot) {
      session.projectRoot = rec.projectRoot
      session.workingDir = session.workingDir || rec.projectRoot
    }
    if (rec.gitBranch) session.gitBranch = rec.gitBranch
    session.lastEventAt = now
    session.lastActiveAt = now
  }

  // 已 dismiss 的会话：除非来了新的 waiting hook 事件，否则不复活
  if (session.dismissed) {
    if (shouldRevive(rec)) {
      session.dismissed = false
    } else {
      persist('sessions')
      return false
    }
  }

  // 空会话（无真实用户消息）：不建隐式 task、不入队。
  // 已有 task 的不在此拦截（曾有真实内容，状态另算）；动态——后续有真实消息即放行。
  if (isEmptySession(rec) && !session.taskId) {
    persist('sessions')
    return false
  }

  // 找/建该 session 对应的隐式 task
  let task = session.taskId ? taskStore.tasks.find((t) => t.id === session.taskId) : null
  if (!task) {
    task = {
      id: genId('t'),
      title: session.label || rec.projectName || '(未命名会话)',
      context: null,
      priority: 'P2',
      type: 'review',
      status: 'queued',
      sessions: [session.id],
      implicit: true,
      createdAt: now,
      queuedAt: now,
      startedAt: null,
      completedAt: null,
      skipCount: 0,
      deferUntil: null,
      notes: null,
    }
    taskStore.tasks.push(task)
    session.taskId = task.id
  } else {
    // 同步标题（会话 summary 可能后补）+ 已完成的任务只在新 waiting hook 事件时复活
    if (session.label) task.title = session.label
    if (task.status === 'done' && shouldRevive(rec)) {
      task.status = 'queued'
      task.queuedAt = now
      task.completedAt = null
    }
  }
  // 把 liveState 同步到 task 上，供排序/展示
  task.liveState = session.liveState

  persist('sessions')

  // 值得让面板冒出来的信号：新会话、或转为 waiting/completed
  const surfacing =
    isNew || rec.liveState === 'waiting' || rec.liveState === 'completed'
  notifyChange()
  return surfacing
}

export function dismissTask(id) {
  const taskStore = getTasks()
  const sessStore = getSessions()
  const task = taskStore.tasks.find((t) => t.id === id)
  if (!task) return null
  task.status = 'skipped'
  // 关联 session 标记 dismissed，不再因扫描/普通事件复活
  for (const sid of task.sessions || []) {
    const s = sessStore.sessions.find((x) => x.id === sid)
    if (s) s.dismissed = true
  }
  persist('sessions')
  notifyChange()
  return task
}

export function patchTask(id, patch = {}) {
  const data = getTasks()
  const task = data.tasks.find((t) => t.id === id)
  if (!task) return null
  const allowed = ['title', 'context', 'priority', 'type', 'notes']
  for (const k of allowed) if (k in patch) task[k] = patch[k]
  notifyChange()
  return task
}

export function doneTask(id, notes) {
  const data = getTasks()
  const task = data.tasks.find((t) => t.id === id)
  if (!task) return null
  task.status = 'done'
  task.completedAt = Date.now()
  if (notes != null) task.notes = notes
  // 归档到 history（保留在 tasks 里也行，V1 两边都留一份便于统计）
  getHistory().tasks.push({ ...task })
  persist('history')
  notifyChange()
  return task
}

export function skipTask(id) {
  const data = getTasks()
  const task = data.tasks.find((t) => t.id === id)
  if (!task) return null
  // 返回前先把「skip 影响到的两个字段」原样快照打包，供前端 4s 撤销窗口回灌。
  // 只快照 skip 真正动的字段，不快照整个 task —— 避免撤销窗口内别处改了 title 也被覆盖。
  const prev = { queuedAt: task.queuedAt, skipCount: task.skipCount || 0 }
  task.skipCount = prev.skipCount + 1
  task.queuedAt = Date.now() // 重新排到同优先级末尾
  notifyChange()
  return { ...task, _prev: prev }
}

// 撤销 skip：把 queuedAt / skipCount 还原到 prev 快照。
// 用 prev 而非「减一」是因为：撤销窗口内可能其他动作也碰过 skipCount（虽然 UI 上不太可能），
// 一律还原成动作前的样子最安全。task 不存在/已是 done 则不做事，返回 null。
export function unskipTask(id, prev = {}) {
  if (!prev || typeof prev.queuedAt !== 'number' || typeof prev.skipCount !== 'number') {
    return null
  }
  const data = getTasks()
  const task = data.tasks.find((t) => t.id === id)
  if (!task) return null
  if (task.status === 'done' || task.status === 'skipped') {
    // task 已被进一步处理，撤销 skip 这一步意义不大；按设计文档「克制」原则不操作。
    return null
  }
  task.queuedAt = prev.queuedAt
  task.skipCount = prev.skipCount
  notifyChange()
  return task
}

export function deferTask(id, minutes = 60) {
  const data = getTasks()
  const task = data.tasks.find((t) => t.id === id)
  if (!task) return null
  task.deferUntil = Date.now() + minutes * 60 * 1000
  notifyChange()
  return task
}

// 提前唤回：清掉 deferUntil，任务立即重新参与排序
export function undeferTask(id) {
  const data = getTasks()
  const task = data.tasks.find((t) => t.id === id)
  if (!task) return null
  task.deferUntil = null
  task.queuedAt = Date.now() // 唤回即视为「现在又要看它」，排到同档末尾
  notifyChange()
  return task
}

// defer 到点的任务需要重新浮现 — 由定时器周期性触发重算
export function tickDefer() {
  const { tasks } = getTasks()
  const now = Date.now()
  const due = tasks.some((t) => t.deferUntil && t.deferUntil <= now)
  if (due) {
    for (const t of tasks) if (t.deferUntil && t.deferUntil <= now) t.deferUntil = null
    notifyChange()
  } else if (shouldAutoReviveAll(tasks, now)) {
    // 没有到点的,但队列已空、只剩被推迟的 → 全部唤回(notifyChange 内做实际清空)
    notifyChange()
  }
}
