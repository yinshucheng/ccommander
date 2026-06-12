import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCurrent, selectedExists } from '../src/client/review-select.js'

const queue = {
  current: { id: 'cur' },
  waiting: [{ id: 'w1' }, { id: 'w2' }],
  deferred: [{ id: 'd1' }],
  done: [{ id: 'done1' }],
}

test('没钉住 → 显示队列头部 current', () => {
  assert.equal(resolveCurrent(queue, null).id, 'cur')
})

test('钉住 waiting 里的 task → 显示它，而非 current', () => {
  assert.equal(resolveCurrent(queue, 'w2').id, 'w2')
})

test('钉住 deferred 里的 task → 显示它', () => {
  assert.equal(resolveCurrent(queue, 'd1').id, 'd1')
})

test('钉住的 task 已不在活跃队列(完成/移除) → 回落到 current', () => {
  assert.equal(resolveCurrent(queue, 'gone').id, 'cur')
})

test('done 里的 task 不算活跃 → 钉它也回落到 current', () => {
  // 钉住的 task 一旦进 done 段即视为消失，批阅页回到 current
  assert.equal(resolveCurrent(queue, 'done1').id, 'cur')
})

test('selectedExists：钉住 null 永远 false（没钉住不触发解除）', () => {
  assert.equal(selectedExists(queue, null), false)
})

test('selectedExists：活跃队列里的 id → true，否则 false（驱动自动解除钉住）', () => {
  assert.equal(selectedExists(queue, 'w1'), true)
  assert.equal(selectedExists(queue, 'cur'), true)
  assert.equal(selectedExists(queue, 'gone'), false)
  assert.equal(selectedExists(queue, 'done1'), false) // done 不在活跃集
})

test('空队列不崩：current 为 null', () => {
  assert.equal(resolveCurrent({ current: null, waiting: [], deferred: [] }, 'x'), null)
  assert.equal(selectedExists({ current: null, waiting: [], deferred: [] }, 'x'), false)
})
