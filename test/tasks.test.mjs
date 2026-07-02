// tasks.js 调度语义回归测试 —— spec 009。
// 钉住「点完成后被 scan 反复复活」(问题1) 与「空会话入队」(问题4) 这两个 bug。
// 测在根因层：复活/过滤都是 upsertFromAgent 调用的纯函数判定，直接断言纯函数，
// 不碰 store 单例 / 不写 data/*.json（避免污染真实数据）。
//
// 跑: pnpm test  (= node --test test/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRevive, isEmptySession } from '../src/server/tasks.js'

// ── 问题 1：done/dismissed 会话的复活规则 ──
// 根因：旧逻辑里任何 liveState==='waiting' 都复活，scan 的近似 waiting 也会把
// 已完成任务打回队列 → 点完成后周期扫描反复复活。修正：只认 hook 的 waiting。

test('回归(问题1): scan 的 waiting 不复活已完成任务', () => {
  assert.equal(
    shouldRevive({ liveState: 'waiting', source: 'scan' }),
    false,
    'scan 扫到 waiting 不该复活 done —— 否则点完成后被周期扫描打回队列'
  )
})

test('回归(问题1): scan 的 idle 不复活', () => {
  assert.equal(shouldRevive({ liveState: 'idle', source: 'scan' }), false)
})

test('回归(问题1): hook 的 waiting 才复活（又有新事要你处理）', () => {
  assert.equal(
    shouldRevive({ liveState: 'waiting', source: 'hook' }),
    true,
    'hook 明确 waiting 应能复活 —— 这是「完成后又被 @ 了」的唯一合法复活路径'
  )
})

test('回归(问题1): hook 的非 waiting 态（completed/running）不复活', () => {
  assert.equal(shouldRevive({ liveState: 'completed', source: 'hook' }), false)
  assert.equal(shouldRevive({ liveState: 'running', source: 'hook' }), false)
})

test('回归(问题1): 缺字段不炸、判 false', () => {
  assert.equal(shouldRevive(undefined), false)
  assert.equal(shouldRevive({}), false)
})

// ── 问题 4：空会话过滤（动态）──
// 无真实用户消息的会话不入队；hasRealUserMsg 每次扫描带上 → 后续有真实消息即放行。

test('回归(问题4): 明确无真实用户消息 → 判为空会话（过滤）', () => {
  assert.equal(
    isEmptySession({ hasRealUserMsg: false }),
    true,
    'transcript 无真实 user 消息的会话应被过滤，不建隐式 task'
  )
})

test('回归(问题4): 有真实用户消息 → 不过滤（动态放行）', () => {
  assert.equal(
    isEmptySession({ hasRealUserMsg: true }),
    false,
    '有真实用户消息应放行 —— 满足「后续有了能重新检测到」'
  )
})

test('回归(问题4): 未知（旧来源未带标志）→ 不过滤（向后兼容）', () => {
  assert.equal(isEmptySession({}), false, 'undefined 视为未知，保守不过滤')
  assert.equal(isEmptySession(undefined), false)
})

// ── skip / unskip 撤销契约（用户原话：撤销跳过好像不管用 —— 重写 act 链路后必须钉死）──
// skip 返回响应里带 _prev 快照(queuedAt + skipCount)；unskip 用 prev 还原这两个字段。
// 4s 撤销窗口内点撤销 = 把任务从「队尾」放回「原位」、skipCount 不留尾巴。

import { init, getTasks, persist } from '../src/server/store.js'
import { skipTask, unskipTask } from '../src/server/tasks.js'

function setupTask({ id = 't1', queuedAt = 1000, skipCount = 0, status = 'queued' } = {}) {
  init()
  const { tasks } = getTasks()
  tasks.length = 0
  tasks.push({
    id, title: 't', priority: 'P2', status,
    sessions: [], createdAt: 0, queuedAt, skipCount,
  })
}

test('skip 返回响应带 _prev = {queuedAt, skipCount}', () => {
  setupTask({ queuedAt: 1000, skipCount: 2 })
  const r = skipTask('t1')
  assert.ok(r._prev, '响应必须带 _prev')
  assert.equal(r._prev.queuedAt, 1000, 'prev.queuedAt 必须是 skip 前的值')
  assert.equal(r._prev.skipCount, 2, 'prev.skipCount 必须是 skip 前的值')
})

test('skip 后 skipCount++ 且 queuedAt 推到现在', () => {
  setupTask({ queuedAt: 1000, skipCount: 2 })
  const r = skipTask('t1')
  assert.equal(r.skipCount, 3)
  assert.ok(r.queuedAt > 1000, 'skip 必须把 queuedAt 推到现在')
})

test('unskip 用 prev 把 queuedAt / skipCount 还原', () => {
  setupTask({ queuedAt: 1000, skipCount: 2 })
  const skipResp = skipTask('t1')
  const after = unskipTask('t1', skipResp._prev)
  assert.equal(after.queuedAt, 1000, '撤销后 queuedAt 回到 skip 前')
  assert.equal(after.skipCount, 2, '撤销后 skipCount 回到 skip 前，不留尾巴')
})

test('unskip: prev 缺字段/非数字 → 拒绝（保护性）', () => {
  setupTask({ queuedAt: 1000, skipCount: 0 })
  skipTask('t1')
  assert.equal(unskipTask('t1', {}), null)
  assert.equal(unskipTask('t1', { queuedAt: 1000 }), null) // 缺 skipCount
  assert.equal(unskipTask('t1', { queuedAt: '1000', skipCount: 0 }), null) // 类型错
  assert.equal(unskipTask('t1', null), null)
  assert.equal(unskipTask('t1', undefined), null)
})

test('unskip: task 已 done/skipped → 不操作（撤销过期）', () => {
  setupTask({ queuedAt: 1000, skipCount: 0, status: 'done' })
  assert.equal(unskipTask('t1', { queuedAt: 1000, skipCount: 0 }), null, 'done 后不接受撤销')
})

test('unskip: 不存在的 task → null', () => {
  setupTask()
  assert.equal(unskipTask('nope', { queuedAt: 0, skipCount: 0 }), null)
})
