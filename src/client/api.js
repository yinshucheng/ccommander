async function req(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export const api = {
  queue: () => req('/api/queue'),
  current: () => req('/api/current'),
  stats: () => req('/api/stats'),
  overview: () => req('/api/overview'),
  add: (data) => req('/api/tasks', 'POST', data),
  // 改任务字段（当前用于改优先级）；后端 patchTask 白名单：title/context/priority/type/notes
  patchTask: (id, data) => req(`/api/tasks/${id}`, 'PATCH', data),
  done: (id, notes) => req(`/api/tasks/${id}/done`, 'POST', { notes }),
  skip: (id) => req(`/api/tasks/${id}/skip`, 'POST'),
  unskip: (id, prev) => req(`/api/tasks/${id}/unskip`, 'POST', { prev }),
  defer: (id, minutes) => req(`/api/tasks/${id}/defer`, 'POST', { minutes }),
  undefer: (id) => req(`/api/tasks/${id}/undefer`, 'POST'),
  dismiss: (id) => req(`/api/tasks/${id}/dismiss`, 'POST'),
  // 聚焦窗口（spec 017）：圈选一批 task + 时长(分钟)进入聚焦；清除退出。
  setFocus: (taskIds, minutes) => req('/api/focus', 'POST', { taskIds, minutes }),
  clearFocus: () => req('/api/focus', 'DELETE'),
  // 配置
  getConfig: () => req('/api/config'),
  patchConfig: (data) => req('/api/config', 'PATCH', data),
  // 会话上下文 / 分析 / 续话
  context: (sid, { limit, before } = {}) => {
    const qs = new URLSearchParams()
    if (limit != null) qs.set('limit', limit)
    if (before != null) qs.set('before', before)
    const q = qs.toString()
    return req(`/api/sessions/${sid}/context${q ? `?${q}` : ''}`)
  },
  analyze: (sid) => req(`/api/sessions/${sid}/analyze`, 'POST'),
  send: (sid, text, images) => req(`/api/sessions/${sid}/send`, 'POST', { text, images }),
  // 权限审批/澄清/计划作答回灌（spec 015）。decision: {behavior:'allow'|'deny', updatedInput?, message?}
  permission: (sid, toolUseId, decision) =>
    req(`/api/sessions/${sid}/permission`, 'POST', { tool_use_id: toolUseId, decision }),
  // 第 5 项：会话长驻进程死了 / 需要重启时调它（前端「重启会话」按钮）
  // 失败时返回 { ok:false, error, stderrTail?, hint? } —— 不抛，前端按字段渲染
  restart: async (sid) => {
    const res = await fetch(`/api/sessions/${sid}/restart`, { method: 'POST' })
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  },
  // A-1：ESC 中断本轮。返回 { ok, escalated?, noProc? }。第一次 SIGINT，第二次 SIGTERM。
  abort: (sid) => req(`/api/sessions/${sid}/abort`, 'POST'),
  // A-2b：斜杠命令分发（commander 端模拟 / 透传 / 拒收）。失败时返回 {ok:false,error}
  // 不走 req 的 throw，让前端能把 error 文案显示出来
  slash: async (sid, text, imagePaths = []) => {
    const res = await fetch(`/api/sessions/${sid}/slash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, imagePaths }),
    })
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  },
  // 启动全新会话：返回 { ok, error? }（不走 req 的 throw，以便拿到 4xx 的 error 文案）
  newSession: async ({ workingDir, text }) => {
    const res = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir, text }),
    })
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  },
}

// 轻量 pub/sub：把 ws 收到的 converse 增量分发给订阅的 ContextView
const convoListeners = new Set()
export function onConverse(fn) {
  convoListeners.add(fn)
  return () => convoListeners.delete(fn)
}
export function emitConverse(msg) {
  convoListeners.forEach((fn) => fn(msg))
}
