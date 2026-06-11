// 续话流式状态归并 —— 根因层纯函数（从 TaskCard 抽出，便于回归测试）。
//
// 背景见 specs/010：网页续话走 `claude -p --resume`，每轮流式增量累加到 reply。
// 一轮结束（ws phase:'done'）时，必须把累计的 reply 沉淀成一条 assistant 历史消息，
// 否则下一轮 doSend 的 setReply('') 会把上一轮 AI 回复直接清掉 —— 多轮澄清就此断裂。
//
// 实测已确认（specs/010 实现记录）：`-p --resume <sid>` 不 fork 新 sid、续写同一
// transcript、上下文连续。故多轮只需前端把回复沉淀进 msgs，后端 sid 追踪/权限无需改动。

// 一轮续话结束：把累计的 reply 作为一条 assistant 消息追加进 msgs。
// - reply 为空（纯工具调用无文本 / 出错）→ 不追加，返回原数组的浅拷贝。
// - seq:-1 复用「乐观插入」约定（非真实 transcript seq）；ts 由 caller 传入（避免本模块依赖时钟，便于测试）。
export function foldReplyIntoHistory(msgs, reply, ts) {
  const list = Array.isArray(msgs) ? msgs : []
  const text = typeof reply === 'string' ? reply.trim() : ''
  if (!text) return [...list]
  return [...list, { seq: -1, role: 'assistant', text, ts: ts ?? null }]
}
