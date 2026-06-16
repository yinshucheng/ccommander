// session-alias.js 单测（第 3 项的根因层，纯函数）。
// 不变量：
//   ① reassignSession 把 procs map 的 key old→new、不重启进程
//   ② recordAlias 把 oldSid 追加到目标 session 的 aliases 数组
//   ③ resolveAlias 能从别名查回当家 sid
//   ④ 同一对 (old,new) 重复 record 是幂等的

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { init, getSessions } from '../src/server/store.js'
import {
  reassignSession,
  recordAlias,
  resolveAlias,
  _resetForTest,
} from '../src/server/session-alias.js'

function setup() {
  init()
  const { sessions } = getSessions()
  sessions.length = 0
  _resetForTest()
}

test('reassignSession: procs map key 从 old 迁到 new，进程不重启', () => {
  setup()
  // 备出一个 session 让 recordAlias 有目标可绑
  getSessions().sessions.push({
    id: 's1',
    claudeSessionId: 'sid-new',
    sessionId: 'sid-new',
    aliases: [],
  })
  const fakeChild = { killed: false, marker: 'unique-proc' }
  const procs = new Map([['sid-old', { child: fakeChild }]])
  const ok = reassignSession(procs, 'sid-old', 'sid-new')
  assert.equal(ok, true)
  assert.equal(procs.has('sid-old'), false, 'old key 应被删除')
  assert.equal(procs.has('sid-new'), true, 'new key 应已建立')
  assert.equal(procs.get('sid-new').child.marker, 'unique-proc', '进程对象同一个（未重启）')
})

test('recordAlias: oldSid 追加进 session.aliases，幂等', () => {
  setup()
  getSessions().sessions.push({
    id: 's1',
    claudeSessionId: 'sid-new',
    sessionId: 'sid-new',
    aliases: [],
  })
  assert.equal(recordAlias('sid-old', 'sid-new'), true)
  assert.deepEqual(getSessions().sessions[0].aliases, ['sid-old'])
  // 重复调一次不再写
  assert.equal(recordAlias('sid-old', 'sid-new'), false)
  assert.deepEqual(getSessions().sessions[0].aliases, ['sid-old'])
})

test('recordAlias: 目标 session 不存在但 old session 存在 → 把 old 改名为 new', () => {
  setup()
  // 模拟首次 fork：只存在 old 的 session 记录
  getSessions().sessions.push({
    id: 's1',
    claudeSessionId: 'sid-old',
    sessionId: 'sid-old',
    aliases: [],
  })
  assert.equal(recordAlias('sid-old', 'sid-new'), true)
  const s = getSessions().sessions[0]
  assert.equal(s.claudeSessionId, 'sid-new', '当家 sid 已切到 new')
  assert.deepEqual(s.aliases, ['sid-old'], 'old 退到 aliases')
})

test('resolveAlias: 别名能查回当家 sid', () => {
  setup()
  getSessions().sessions.push({
    id: 's1',
    claudeSessionId: 'sid-new',
    sessionId: 'sid-new',
    aliases: ['sid-old'],
  })
  assert.equal(resolveAlias('sid-old'), 'sid-new', '别名 → 当家')
  assert.equal(resolveAlias('sid-new'), 'sid-new', '当家 → 自己')
  assert.equal(resolveAlias('sid-unknown'), 'sid-unknown', '陌生 sid 原样返回')
})

test('reassignSession: 同 sid / 空 sid 是 no-op', () => {
  setup()
  const procs = new Map([['x', { child: {} }]])
  assert.equal(reassignSession(procs, 'x', 'x'), false)
  assert.equal(reassignSession(procs, '', 'y'), false)
  assert.equal(reassignSession(procs, 'x', ''), false)
})
