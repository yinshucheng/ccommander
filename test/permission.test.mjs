// permission.js / perm-registry.js 回归测试（spec 015）。
// 钉住核心不变量：决定校验 fail-closed、cmdTemplate→放行派生、请求按 tool_use_id 配对、超时兜底。
// 跑: pnpm test  (= node --test test/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDecision, templateSkipsPermissions, buildUserMessage } from '../src/server/permission.js'

// ── normalizeDecision：fail closed，非法一律 deny ──
test('normalizeDecision: allow 透传 updatedInput（仅对象）', () => {
  assert.deepEqual(normalizeDecision({ behavior: 'allow' }), { behavior: 'allow' })
  assert.deepEqual(normalizeDecision({ behavior: 'allow', updatedInput: { a: 1 } }), {
    behavior: 'allow',
    updatedInput: { a: 1 },
  })
  // updatedInput 非对象 → 丢弃
  assert.deepEqual(normalizeDecision({ behavior: 'allow', updatedInput: 'x' }), { behavior: 'allow' })
})

test('normalizeDecision: deny 带 message；缺省给默认文案', () => {
  assert.deepEqual(normalizeDecision({ behavior: 'deny', message: '不行' }), {
    behavior: 'deny',
    message: '不行',
  })
  assert.equal(normalizeDecision({ behavior: 'deny' }).message, 'Denied by user')
})

test('normalizeDecision: 非法/缺失/垃圾一律 fail closed → deny', () => {
  for (const raw of [null, undefined, {}, { behavior: 'maybe' }, { behavior: '' }, 'garbage', 42]) {
    assert.equal(normalizeDecision(raw).behavior, 'deny', `应 deny: ${JSON.stringify(raw)}`)
  }
})

// ── templateSkipsPermissions：放行派生自 cmdTemplate ──
test('templateSkipsPermissions: 含 skip / bypass → true', () => {
  assert.equal(templateSkipsPermissions('ccr code --dangerously-skip-permissions --resume {sessionId}'), true)
  assert.equal(templateSkipsPermissions('claude --dangerously-skip-permissions --resume {sessionId}'), true)
  assert.equal(templateSkipsPermissions('claude --permission-mode bypassPermissions --resume {sessionId}'), true)
})

test('templateSkipsPermissions: 不含 → false（走交互审批）', () => {
  assert.equal(templateSkipsPermissions('claude --resume {sessionId}'), false)
  assert.equal(templateSkipsPermissions('ccr code --resume {sessionId}'), false)
  assert.equal(templateSkipsPermissions(''), false)
  assert.equal(templateSkipsPermissions('claude --permission-mode default --resume {sessionId}'), false)
})

// ── buildUserMessage：stream-json 输入格式 ──
test('buildUserMessage: 纯文本', () => {
  assert.deepEqual(buildUserMessage('hi'), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  })
})

test('buildUserMessage: 文本 + 图片块', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }
  const m = buildUserMessage('看图', [img])
  assert.equal(m.message.content.length, 2)
  assert.deepEqual(m.message.content[1], img)
})

test('buildUserMessage: 空文本不产生空 text 块', () => {
  assert.deepEqual(buildUserMessage('').message.content, [])
})

// ── perm-registry：配对 + 超时 + 会话回收 ──
// 注意：requestPermission 会 broadcast（依赖 bus 的 clients 集合，空集时是 no-op），可安全调用。
test('perm-registry: 缺 tool_use_id 直接 deny，不挂起', async () => {
  const { requestPermission, pendingCount } = await import('../src/server/perm-registry.js')
  const d = await requestPermission({ sid: 's', tool_name: 'Write', input: {} })
  assert.equal(d.behavior, 'deny')
  assert.equal(pendingCount(), 0)
})

test('perm-registry: 请求挂起 → resolvePermission 按 tool_use_id 落定', async () => {
  const { requestPermission, resolvePermission, pendingCount } = await import('../src/server/perm-registry.js')
  const p = requestPermission({ sid: 's1', tool_name: 'Write', input: { a: 1 }, tool_use_id: 'tu-A' })
  assert.equal(pendingCount(), 1)
  const hit = resolvePermission('tu-A', { behavior: 'allow', updatedInput: { a: 2 } })
  assert.equal(hit, true)
  const d = await p
  assert.deepEqual(d, { behavior: 'allow', updatedInput: { a: 2 } })
  assert.equal(pendingCount(), 0)
})

test('perm-registry: 超时兜底 → deny', async () => {
  const { requestPermission } = await import('../src/server/perm-registry.js')
  const d = await requestPermission(
    { sid: 's2', tool_name: 'Bash', input: {}, tool_use_id: 'tu-T' },
    { timeoutMs: 20 }
  )
  assert.equal(d.behavior, 'deny')
  assert.match(d.message, /timed out/)
})

test('perm-registry: 会话回收把名下挂起请求全部 deny', async () => {
  const { requestPermission, failPendingForSession, pendingCount } = await import('../src/server/perm-registry.js')
  const p1 = requestPermission({ sid: 'sX', tool_name: 'Write', input: {}, tool_use_id: 'tu-X1' })
  const p2 = requestPermission({ sid: 'sX', tool_name: 'Bash', input: {}, tool_use_id: 'tu-X2' })
  assert.equal(pendingCount(), 2)
  failPendingForSession('sX', 'gone')
  assert.equal((await p1).behavior, 'deny')
  assert.equal((await p2).behavior, 'deny')
  assert.equal(pendingCount(), 0)
})
