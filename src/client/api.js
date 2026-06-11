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
  done: (id, notes) => req(`/api/tasks/${id}/done`, 'POST', { notes }),
  skip: (id) => req(`/api/tasks/${id}/skip`, 'POST'),
  defer: (id, minutes) => req(`/api/tasks/${id}/defer`, 'POST', { minutes }),
  undefer: (id) => req(`/api/tasks/${id}/undefer`, 'POST'),
  dismiss: (id) => req(`/api/tasks/${id}/dismiss`, 'POST'),
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
