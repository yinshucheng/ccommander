// 排序引擎
// 1. deferUntil 未到的任务不参与（隐藏）
// 2. P0 始终置顶
// 3. liveState 权重：🟡可能在等你 > ✓已完成 > 🔵在跑 > ⚪静默（让等你的会话先冒出来）
// 4. 同档按 queuedAt 升序（先等先处理）
// 5. skipCount 降权

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 }

// liveState 权重：可能在等你 > 已完成 > 在跑 > 静默 > 无状态
const LIVE_RANK = { waiting: 0, completed: 1, running: 2, idle: 3 }
const liveRank = (t) => (t.liveState != null ? LIVE_RANK[t.liveState] ?? 4 : 4)

// 一个任务当前是否在队列里等待处理（排除 done/skipped 与未到点的 defer）
export function isQueued(task, now = Date.now()) {
  if (task.status !== 'queued' && task.status !== 'active') return false
  if (task.deferUntil && task.deferUntil > now) return false
  return true
}

export function rank(tasks, now = Date.now()) {
  return tasks
    .filter((t) => isQueued(t, now))
    .sort((a, b) => {
      // P0 始终置顶
      const p0a = a.priority === 'P0' ? 0 : 1
      const p0b = b.priority === 'P0' ? 0 : 1
      if (p0a !== p0b) return p0a - p0b
      // liveState 权重（等你的先来）
      const lr = liveRank(a) - liveRank(b)
      if (lr !== 0) return lr
      // 其余优先级
      const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      if (pr !== 0) return pr
      // skip 降权
      if (a.skipCount !== b.skipCount) return a.skipCount - b.skipCount
      const qa = a.queuedAt ?? a.createdAt
      const qb = b.queuedAt ?? b.createdAt
      return qa - qb
    })
}

// 选出当前应该处理的任务（队列首位）
export function pickCurrent(tasks, now = Date.now()) {
  const ranked = rank(tasks, now)
  return ranked[0] ?? null
}

// 把任务分组，供侧边队列面板展示
export function groupQueue(tasks, now = Date.now()) {
  const ranked = rank(tasks, now)
  const current = ranked[0] ?? null
  const waiting = ranked.slice(1)
  const deferred = tasks.filter(
    (t) => t.deferUntil && t.deferUntil > now && t.status !== 'done' && t.status !== 'skipped'
  )
  const done = tasks.filter((t) => t.status === 'done')
  return { current, waiting, deferred, done }
}
