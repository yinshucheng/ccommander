// 内置 permission-prompt MCP server（独立 stdio 子进程）。
//
// 由续话长驻进程作为 MCP 子进程拉起（spec 015）。Claude 在 --permission-mode default
// 下想用工具/反问（AskUserQuestion/ExitPlanMode）时，会调用本 server 暴露的 `approve`
// 工具来征求许可。本 server 把请求经 HTTP 转交 commander 主进程（主进程才连着 ws/前端），
// 阻塞等用户在网页上点「允许/拒绝」，再把决定作为工具结果返回给 Claude。
//
// 为什么是独立进程：--permission-prompt-tool 要求工具名形如 mcp__<server>__<tool>，
// 且该 MCP server 经 --mcp-config 以 stdio 子进程方式挂载——它不能是 commander 主进程本身。
//
// 与主进程的回环通道：HTTP POST <COMMANDER_INTERNAL_URL>/internal/permission
//   body: { token, sid, tool_name, input, tool_use_id }
//   主进程长轮询挂起，用户答复后返回 { decision: { behavior, updatedInput?, message? } }
// 配置经环境变量注入（spawn 时设）：
//   COMMANDER_PERM_URL   主进程内部端点完整 URL
//   COMMANDER_PERM_TOKEN 校验 token（防外部伪造）
//   COMMANDER_PERM_SID   本进程对应的会话 id
//
// 这是个零依赖的最小 MCP server（手写 JSON-RPC over stdio），不引第三方 MCP SDK。

import { createInterface } from 'node:readline'
import { normalizeDecision } from './permission.js'

const URL_ = process.env.COMMANDER_PERM_URL || ''
const TOKEN = process.env.COMMANDER_PERM_TOKEN || ''
const SID = process.env.COMMANDER_PERM_SID || ''

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// 工具入参 schema 与 Claude 实际传参对齐（实测 claude 传 {tool_name, input, tool_use_id}，
// 还带 _meta['claudecode/toolUseId']）。additionalProperties 放开以免漏字段。
const APPROVE_TOOL = {
  name: 'approve',
  description:
    'Permission prompt: decide whether Claude may use a tool, or relay an AskUserQuestion / ExitPlanMode to the user. Returns {behavior:"allow"|"deny", updatedInput?, message?}.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object', additionalProperties: true },
      tool_use_id: { type: 'string' },
    },
    additionalProperties: true,
  },
}

// 把决定包装成 MCP 工具结果。permission-prompt-tool 约定：结果文本是 decision 的 JSON。
function decisionResult(id, decision) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
  }
}

// 向主进程请求决定；任何异常 → 兜底 deny（fail closed，绝不静默放行）。
async function askMain(args) {
  if (!URL_ || !TOKEN) {
    return { behavior: 'deny', message: 'permission channel not configured' }
  }
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: TOKEN,
        sid: SID,
        tool_name: args?.tool_name || '',
        input: args?.input ?? {},
        tool_use_id: args?.tool_use_id || args?._meta?.['claudecode/toolUseId'] || '',
      }),
    })
    if (!res.ok) return { behavior: 'deny', message: `permission endpoint ${res.status}` }
    const body = await res.json()
    return normalizeDecision(body?.decision)
  } catch (e) {
    return { behavior: 'deny', message: `permission channel error: ${e.message}` }
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let m
  try {
    m = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = m
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'commander', version: '1' },
      },
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [APPROVE_TOOL] } })
  } else if (method === 'tools/call') {
    if (params?.name !== 'approve') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } })
      return
    }
    const decision = await askMain(params?.arguments || {})
    send(decisionResult(id, decision))
  } else if (method === 'notifications/initialized' || id === undefined) {
    // 通知类消息无需回复
  } else {
    // 其它带 id 的请求：回个空 result，避免对端等待
    send({ jsonrpc: '2.0', id, result: {} })
  }
})
