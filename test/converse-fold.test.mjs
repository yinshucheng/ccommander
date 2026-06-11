// converse-fold 回归测试 —— 钉住「续话流式回复必须沉淀进历史」这个根因不变量。
// 跑: pnpm test  (= node --test test/)
//
// Bug（specs/010）：TaskCard 的 done 分支从不把累计的 reply 并入 msgs，
// 下一轮 doSend 的 setReply('') 直接清掉上一轮 AI 回复 → 多轮澄清断裂、面板对话不连续。
// 根因层断言：foldReplyIntoHistory 必须把非空 reply 追加为一条 assistant 消息。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldReplyIntoHistory } from '../src/client/converse-fold.js'

test('非空 reply 被追加为一条 assistant 历史消息', () => {
  const before = [{ seq: 1, role: 'user', text: '帮我改下' }]
  const after = foldReplyIntoHistory(before, '你是指 A 文件还是 B 文件？', 1000)
  assert.equal(after.length, 2)
  const last = after[after.length - 1]
  assert.equal(last.role, 'assistant')
  assert.equal(last.text, '你是指 A 文件还是 B 文件？')
  assert.equal(last.ts, 1000)
})

test('多轮：连续两次 fold 保留全部往返，不互相清空', () => {
  let msgs = [{ seq: 1, role: 'user', text: '改一下' }]
  msgs = foldReplyIntoHistory(msgs, '你指哪个文件？', 1) // AI 反问
  msgs = [...msgs, { seq: -1, role: 'user', text: 'A 文件' }] // 用户接着答（doSend 乐观插入）
  msgs = foldReplyIntoHistory(msgs, '好的，已改 A', 2) // AI 再答
  assert.deepEqual(
    msgs.map((m) => `${m.role}:${m.text}`),
    ['user:改一下', 'assistant:你指哪个文件？', 'user:A 文件', 'assistant:好的，已改 A']
  )
})

test('空/纯空白 reply 不追加（纯工具调用或出错时）', () => {
  const before = [{ seq: 1, role: 'user', text: 'x' }]
  assert.deepEqual(foldReplyIntoHistory(before, '', 1), before)
  assert.deepEqual(foldReplyIntoHistory(before, '   \n  ', 1), before)
  assert.deepEqual(foldReplyIntoHistory(before, undefined, 1), before)
})

test('reply 首尾空白被裁剪，返回新数组不改原数组', () => {
  const before = [{ seq: 1, role: 'user', text: 'x' }]
  const after = foldReplyIntoHistory(before, '  答案  ', 1)
  assert.equal(after[after.length - 1].text, '答案')
  assert.equal(before.length, 1, '不得就地修改入参')
  assert.notEqual(after, before)
})
