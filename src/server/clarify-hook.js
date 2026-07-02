// PreToolUse hook 输出生成器：把 perm-registry 落定的 decision 翻译成 claude
// 文档要求的 hookSpecificOutput JSON 协议（PreToolUse 段）。
//
// 协议参考（2026-06 实测；docs：https://code.claude.com/docs/en/hooks）:
//   - permissionDecision: 'allow' | 'deny' | 'ask' | 'defer'
//   - updatedInput: 替换工具入参（PreToolUse 唯一允许的入参改写位置）
//   - permissionDecisionReason: 解释，'deny' 时尤其重要
//   - additionalContext: 注入到 claude 上下文的说明字符串
//
// AskUserQuestion 的处理逻辑：
//   - decision.behavior === 'allow' 且 updatedInput.answers 存在
//     → 把 answers 合并进原始 input 作为 updatedInput；claude 看到的入参里直接有
//       回答，照常 tool_use → tool_result
//     → additionalContext 说明这是用户实际回答的，避免 claude 自己又来一遍
//   - decision.behavior === 'deny'
//     → permissionDecision: 'deny' + reason；claude 会跳过工具调用
//
// ExitPlanMode 的处理逻辑：
//   - allow  → permissionDecision: 'allow'，claude 视为「用户批准了计划」
//   - deny   → permissionDecision: 'deny' + reason；claude 会按 reason 重新规划

export function renderHookOutput(decision, toolName, originalInput) {
  const d = decision || {}
  const behavior = d.behavior === 'allow' ? 'allow' : 'deny'
  const reason = (d.message || '').trim()

  const out = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: behavior,
    },
  }

  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason

  if (toolName === 'AskUserQuestion' && behavior === 'allow') {
    // 用户在网页选了答案 → 通过 updatedInput 喂给 claude
    const answers = d.updatedInput?.answers
    if (answers && Object.keys(answers).length > 0) {
      out.hookSpecificOutput.updatedInput = {
        ...originalInput,
        // claude 内部 AskUserQuestion schema 没有 answers 字段（用户回答原本来自
        // 终端 stdin）；放在 updatedInput 里让 claude 看到这是个"已答状态"。
        // 同时 additionalContext 把 Q&A 列出来兜底，确保 claude 一定能消费到。
        answers,
      }
      const lines = Object.entries(answers).map(([q, a]) => `- ${q}: ${a}`).join('\n')
      out.hookSpecificOutput.additionalContext = `[用户已在 commander 网页回答 AskUserQuestion]\n${lines}`
    } else {
      // allow 但没 answers（用户跳过 / 卡片协议异常）→ 加个空 context 提示
      out.hookSpecificOutput.additionalContext = '[用户已确认，但未提供具体回答]'
    }
  } else if (toolName === 'ExitPlanMode' && behavior === 'allow') {
    out.hookSpecificOutput.additionalContext = '[用户已在 commander 网页批准计划，请按计划执行]'
  } else if (toolName === 'ExitPlanMode' && behavior === 'deny') {
    out.hookSpecificOutput.additionalContext = reason
      ? `[用户打回计划：${reason}]`
      : '[用户打回计划，请重新规划]'
  } else if (behavior === 'deny') {
    out.hookSpecificOutput.additionalContext = reason
      ? `[用户拒绝：${reason}]`
      : '[用户拒绝]'
  }

  return out
}
