// 聚焦窗口（spec 017）回归测试 —— 需求:窗口期只调度圈选的 task,没圈选的隐藏,
// 唯一例外 waiting 破例冒出(P0 也不例外,聚焦优先)。到点/无窗口则全放行。
// 测在根因层:inFocusScope 是纯判定,rank 在 isQueued 之后叠加它。只断言纯函数,不碰 store。
//
// 跑: pnpm test  (= node --test test/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inFocusScope, rank } from '../src/server/scheduler.js'

const now = Date.now()
const focusOf = (taskIds, untilOffset = 60 * 60 * 1000) => ({
  taskIds,
  until: now + untilOffset,
  createdAt: now,
})
// 一个「在队列里」的 task（status/queuedAt 齐,供 rank 的 isQueued 通过）
const task = (id, extra = {}) => ({ id, status: 'queued', priority: 'P2', queuedAt: now, ...extra })

test('inFocusScope: 无窗口 → 全放行', () => {
  assert.equal(inFocusScope(task('a'), null, now), true)
  assert.equal(inFocusScope(task('a'), undefined, now), true)
})

test('inFocusScope: 窗口已过期 → 全放行（惰性判定）', () => {
  const expired = focusOf(['a'], -1000) // until 在过去
  assert.equal(inFocusScope(task('b'), expired, now), true, '没圈选的 b 在过期窗口下也放行')
})

test('inFocusScope: 圈选的 → 放行', () => {
  assert.equal(inFocusScope(task('a'), focusOf(['a', 'c']), now), true)
})

test('inFocusScope: 没圈选的（非 waiting）→ 隐藏', () => {
  assert.equal(inFocusScope(task('b', { liveState: 'running' }), focusOf(['a']), now), false)
  assert.equal(inFocusScope(task('b', { liveState: 'idle' }), focusOf(['a']), now), false)
  assert.equal(inFocusScope(task('b', { liveState: 'completed' }), focusOf(['a']), now), false)
})

test('inFocusScope: 没圈选的但 waiting → 破例放行', () => {
  assert.equal(
    inFocusScope(task('b', { liveState: 'waiting' }), focusOf(['a']), now),
    true,
    'waiting 是唯一破例:真在等你,别因专注而漏事'
  )
})

test('inFocusScope: 没圈选的 P0 也隐藏（聚焦优先于 P0 硬置顶）', () => {
  assert.equal(
    inFocusScope(task('b', { priority: 'P0', liveState: 'idle' }), focusOf(['a']), now),
    false,
    '聚焦优先:没圈选的 P0 也隐藏,除非它 waiting'
  )
  // 但没圈选的 P0 若 waiting 仍破例
  assert.equal(
    inFocusScope(task('b', { priority: 'P0', liveState: 'waiting' }), focusOf(['a']), now),
    true
  )
})

test('rank 集成: 窗口期结果只含圈选的 + waiting 破例，且排序键不变', () => {
  const tasks = [
    task('a', { liveState: 'idle' }), // 圈选
    task('b', { liveState: 'running' }), // 没圈选、非 waiting → 剔除
    task('c', { liveState: 'waiting' }), // 没圈选但 waiting → 破例保留
    task('d', { priority: 'P0', liveState: 'idle' }), // 没圈选的 P0 → 剔除
  ]
  const ranked = rank(tasks, now, focusOf(['a']))
  const ids = ranked.map((t) => t.id)
  assert.ok(ids.includes('a'), '圈选的 a 保留')
  assert.ok(ids.includes('c'), 'waiting 的 c 破例保留')
  assert.ok(!ids.includes('b'), '没圈选非 waiting 的 b 剔除')
  assert.ok(!ids.includes('d'), '没圈选的 P0 d 剔除')
  // c 是 waiting,权重最高 → 排在 idle 的 a 前面（排序键未被 focus 改动）
  assert.deepEqual(ids, ['c', 'a'])
})

test('rank 集成: 无 focus 时全量参与（等于没这功能）', () => {
  const tasks = [task('a'), task('b'), task('c')]
  assert.equal(rank(tasks, now, null).length, 3)
})
