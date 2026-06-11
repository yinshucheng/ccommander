// 面板分组：纯函数，不依赖 React，便于单测（test/board-group.test.mjs）。
// 输入是 /api/queue 里带 sessionDetails 的 task 列表，输出按维度归好的桶。

const NO_PROJECT = '(无项目)'

// workingDir → 末段目录名（兜底项目名）
function basename(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

export function projectOf(task) {
  const s = (task.sessionDetails || [])[0]
  return s?.projectName || basename(s?.workingDir) || basename(task.workingDir) || NO_PROJECT
}

// 任务对应的真实工作目录（开新会话的 cwd 来源）
export function workingDirOf(task) {
  const s = (task.sessionDetails || [])[0]
  return s?.workingDir || task.workingDir || ''
}

// status 维度的组顺序：等你的先冒头（与 scheduler 的 liveState 权重一致）
const STATUS_ORDER = ['waiting', 'running', 'idle', 'completed']
const STATUS_LABEL = {
  waiting: '🟡 可能在等你',
  running: '🔵 在跑',
  idle: '⚪ 静默',
  completed: '✓ 已完成',
}

const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3']

// tasks → [{ key, label, items[] }]，dimension ∈ project|status|priority
// 组内保持传入顺序（信任 queue 已按 scheduler 排好序）。
export function groupTasks(tasks = [], dimension = 'project') {
  if (dimension === 'status') {
    return orderedGroups(
      tasks,
      (t) => t.liveState || 'idle',
      STATUS_ORDER,
      (k) => STATUS_LABEL[k] || k
    )
  }
  if (dimension === 'priority') {
    return orderedGroups(
      tasks,
      (t) => t.priority || 'P2',
      PRIORITY_ORDER,
      (k) => k
    )
  }
  // project：按出现顺序排组，「(无项目)」永远沉底
  // 每组补一个代表性 workingDir（组内首个 task 的真实目录），供「＋ 新会话」用作 cwd。
  return insertionGroups(tasks, projectOf, NO_PROJECT).map((g) => ({
    ...g,
    workingDir: g.key === NO_PROJECT ? '' : workingDirOf(g.items[0]) || '',
  }))
}

// 固定顺序维度：按 order 数组排组，order 外的追加在后
function orderedGroups(tasks, keyOf, order, labelOf) {
  const buckets = new Map()
  for (const t of tasks) {
    const k = keyOf(t)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(t)
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib)
  })
  return keys.map((k) => ({ key: k, label: labelOf(k), items: buckets.get(k) }))
}

// 按首次出现顺序排组；sinkKey（如「无项目」）始终沉到最后
function insertionGroups(tasks, keyOf, sinkKey) {
  const buckets = new Map()
  for (const t of tasks) {
    const k = keyOf(t)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(t)
  }
  const keys = [...buckets.keys()]
  keys.sort((a, b) => {
    if (a === sinkKey) return 1
    if (b === sinkKey) return -1
    return 0 // 稳定排序保持插入顺序
  })
  return keys.map((k) => ({ key: k, label: k, items: buckets.get(k) }))
}

// 顶部实时计数：按 liveState 聚合
export function countByState(tasks = []) {
  const out = { waiting: 0, running: 0, idle: 0, completed: 0 }
  for (const t of tasks) {
    const st = t.liveState || 'idle'
    out[st] = (out[st] || 0) + 1
  }
  return out
}
