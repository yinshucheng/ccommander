// 权限请求协调器（主进程侧，spec 015）。
//
// perm-server.js（MCP 子进程）POST 进来一个权限请求 → 这里挂起一个 Promise、广播
// permission_request 给前端 → 用户在网页点「允许/拒绝」走 POST 回灌 → resolve 该 Promise
// → perm-server 拿到决定返回给 Claude。
//
// 配对键：tool_use_id（Claude 每次工具调用唯一）。超时兜底：到点默认 deny（fail closed），
// 绝不让子进程永久挂起，也绝不静默放行。
//
// 安全：内部端点用一个随机 token 校验（防本机其它进程伪造）；token 在进程启动时生成，
// 只经环境变量传给我们自己 spawn 的 perm-server 子进程。

import { randomBytes } from 'node:crypto'
import { broadcast } from './bus.js'
import { normalizeDecision } from './permission.js'

const TOKEN = randomBytes(24).toString('hex')
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// 内部端点 URL，由 index.js 在 listen 后设置（含本机端口）。converse.js spawn perm-server
// 时把它 + token 经环境变量传给子进程。
let internalUrl = ''
export function setInternalUrl(url) {
  internalUrl = url
}
export function getInternalUrl() {
  return internalUrl
}

// tool_use_id -> { resolve, timer, sid, tool_name, input, createdAt }
const pending = new Map()

export function getToken() {
  return TOKEN
}

// perm-server 校验用
export function checkToken(t) {
  return typeof t === 'string' && t.length > 0 && t === TOKEN
}

// 收到一个权限请求 → 挂起并广播 → 返回一个 resolve 成 decision 的 Promise。
// req: { sid, tool_name, input, tool_use_id }
export function requestPermission(req, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = req?.tool_use_id || ''
  // 缺 tool_use_id 无法配对 → 直接 deny（不广播半截请求）
  if (!id) {
    return Promise.resolve(normalizeDecision({ behavior: 'deny', message: 'missing tool_use_id' }))
  }
  // 同一 tool_use_id 重复进来（Claude 不会，但防御）：复用已挂起的
  if (pending.has(id)) {
    return pending.get(id).promise
  }

  let resolveFn
  const promise = new Promise((resolve) => {
    resolveFn = resolve
  })
  const timer = setTimeout(() => {
    settle(id, { behavior: 'deny', message: 'Permission request timed out' })
  }, timeoutMs)
  // 不阻止进程退出
  if (timer.unref) timer.unref()

  pending.set(id, {
    promise,
    resolve: resolveFn,
    timer,
    sid: req.sid || '',
    tool_name: req.tool_name || '',
    input: req.input ?? {},
    createdAt: Date.now(),
  })

  // 广播给前端渲染审批/澄清/计划卡片
  broadcast({
    type: 'permission_request',
    sid: req.sid || '',
    tool_use_id: id,
    tool_name: req.tool_name || '',
    input: req.input ?? {},
  })

  return promise
}

// 内部：落定一个挂起请求（用户答复 / 超时 / 会话回收都走这里）。
function settle(id, rawDecision) {
  const rec = pending.get(id)
  if (!rec) return false
  clearTimeout(rec.timer)
  pending.delete(id)
  const decision = normalizeDecision(rawDecision)
  rec.resolve(decision)
  // 通知前端该请求已落定（撤掉卡片）
  broadcast({ type: 'permission_resolved', sid: rec.sid, tool_use_id: id, behavior: decision.behavior })
  return true
}

// 用户在网页上答复（POST 回灌入口调用）。返回是否命中一个挂起请求。
export function resolvePermission(toolUseId, rawDecision) {
  return settle(toolUseId, rawDecision)
}

// 会话被回收/进程死掉时，把它所有挂起请求 deny 掉（避免 perm-server 永久等待）。
export function failPendingForSession(sid, message = 'Session ended') {
  for (const [id, rec] of pending) {
    if (rec.sid === sid) settle(id, { behavior: 'deny', message })
  }
}

// 测试/诊断用
export function pendingCount() {
  return pending.size
}
