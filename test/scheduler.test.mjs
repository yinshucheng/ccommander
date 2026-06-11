// scheduler.js 自动唤回回归测试 —— 需求:队列空了自动把推迟任务放回队列。
// 测在根因层:shouldAutoReviveAll 是纯判定,notifyChange/tickDefer 据此决定是否
// 清掉所有 deferUntil。这里只断言纯函数,不碰 store / 不写 data/*.json。
//
// 跑: pnpm test  (= node --test test/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoReviveAll } from '../src/server/scheduler.js'

const now = Date.now()
const queued = (id, extra = {}) => ({ id, status: 'queued', priority: 'P2', queuedAt: now, ...extra })
const deferred = (id) => queued(id, { deferUntil: now + 30 * 60 * 1000 })

test('唤回: 队列只剩推迟任务 → 应全部唤回', () => {
  assert.equal(
    shouldAutoReviveAll([deferred('a'), deferred('b')], now),
    true,
    '无 current 无 waiting、只剩推迟任务时,应触发全部唤回'
  )
})

test('唤回: 还有未推迟的在队列里 → 不唤回', () => {
  assert.equal(
    shouldAutoReviveAll([queued('a'), deferred('b')], now),
    false,
    '队列里还有活的任务在等,不该提前打扰推迟任务'
  )
})

test('唤回: 没有任何推迟任务 → 不唤回（无事可做）', () => {
  assert.equal(shouldAutoReviveAll([queued('a')], now), false)
  assert.equal(shouldAutoReviveAll([], now), false)
})

test('唤回: done/skipped 不算「队列里还有活的」', () => {
  const done = { id: 'd', status: 'done', priority: 'P2' }
  const skipped = { id: 's', status: 'skipped', priority: 'P2' }
  assert.equal(
    shouldAutoReviveAll([done, skipped, deferred('a')], now),
    true,
    '已完成/已跳过不占队列,只剩推迟任务仍应唤回'
  )
})

test('唤回: 推迟任务已到点(deferUntil<=now)→ 不靠唤回（它自己会浮现）', () => {
  const due = queued('a', { deferUntil: now - 1000 })
  assert.equal(
    shouldAutoReviveAll([due], now),
    false,
    '已到点的任务本就该参与排序,不属于「被推迟而队列空」的情形'
  )
})
