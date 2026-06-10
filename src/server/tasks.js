import { getTasks, getSessions, getHistory, persist } from './store.js'
import { groupQueue, pickCurrent } from './scheduler.js'
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
  return {
    current: attach(groups.current),
    waiting: groups.waiting.map(attach),
    deferred: groups.deferred.map(attach),
    done: groups.done.map(attach),
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
export function notifyChange() {
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
    // hook 数据优先于 scan：scan 不能把 hook 设的精确态覆盖回近似态
    const incomingRank = LIVE_RANK[rec.source || 'scan'] || 1
    const currentRank = LIVE_RANK[session.source || 'scan'] || 1
    if (incomingRank >= currentRank || rec.source === 'hook') {
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

  // 已 dismiss 的会话：除非来了新的 waiting 事件，否则不复活
  if (session.dismissed) {
    if (rec.liveState === 'waiting' && rec.source === 'hook') {
      session.dismissed = false
    } else {
      persist('sessions')
      return false
    }
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
    // 同步标题（会话 summary 可能后补）+ 若已完成又来新事件则重新入队
    if (session.label) task.title = session.label
    if (task.status === 'done' && rec.liveState === 'waiting') {
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
  task.skipCount = (task.skipCount || 0) + 1
  task.queuedAt = Date.now() // 重新排到同优先级末尾
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

// defer 到点的任务需要重新浮现 — 由定时器周期性触发重算
export function tickDefer() {
  const { tasks } = getTasks()
  const now = Date.now()
  const due = tasks.some((t) => t.deferUntil && t.deferUntil <= now)
  if (due) {
    for (const t of tasks) if (t.deferUntil && t.deferUntil <= now) t.deferUntil = null
    notifyChange()
  }
}
