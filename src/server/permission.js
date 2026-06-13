// 权限决定的协议纯函数（根因层，可单测）。spec 015。
//
// 与 Claude Code hooks/canUseTool 文档的约束对齐：
//   - behavior 必须是 'allow' | 'deny'
//   - 'allow' 可带 updatedInput（替换整个 input 对象）
//   - 'deny' 可带 message（告诉 Claude 为何被拒）；updatedInput 在 deny 时无意义
// 这里只做「规整 + 校验」，不做 IO。converse.js / perm-server.js 都用它，便于 node:assert 断言。

// 把前端/调用方给的原始决定规整成合法的 decision 对象。
// 非法/缺失一律 fail closed → deny（绝不静默放行）。
export function normalizeDecision(raw) {
  const behavior = raw?.behavior
  if (behavior === 'allow') {
    const out = { behavior: 'allow' }
    // updatedInput 仅当是对象时透传（替换整个 input）
    if (raw.updatedInput && typeof raw.updatedInput === 'object') {
      out.updatedInput = raw.updatedInput
    }
    return out
  }
  // 其余一律视为 deny
  const out = { behavior: 'deny' }
  out.message = typeof raw?.message === 'string' && raw.message ? raw.message : 'Denied by user'
  return out
}

// cmdTemplate 是否表达了「跳过权限」意图。
// 含 --dangerously-skip-permissions（或 permission-mode bypassPermissions）→ 全放行，
// 不挂 perm 工具、不弹审批（实测 skip 模式下 permission-prompt-tool 根本不被调用）。
export function templateSkipsPermissions(cmdTemplate = '') {
  const t = String(cmdTemplate)
  return (
    /--dangerously-skip-permissions\b/.test(t) ||
    /--permission-mode[=\s]+bypassPermissions\b/.test(t)
  )
}

// 一次续话发往子进程 stdin 的一条 user 消息（stream-json 输入格式）。
// imageBlocks: 可选的 {type:'image',source:{...}} 数组；text 与图片同处一条 content。
export function buildUserMessage(text = '', imageBlocks = []) {
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const b of imageBlocks) content.push(b)
  return { type: 'user', message: { role: 'user', content } }
}
