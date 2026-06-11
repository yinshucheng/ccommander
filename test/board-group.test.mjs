import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupTasks, countByState, projectOf, workingDirOf } from '../src/client/board-group.js'

// 构造一批带 sessionDetails 的 task，覆盖三种分组维度的核心不变量。
const tasks = [
  { id: 'a', priority: 'P2', liveState: 'running', sessionDetails: [{ projectName: 'web' }] },
  { id: 'b', priority: 'P0', liveState: 'waiting', sessionDetails: [{ projectName: 'commander' }] },
  { id: 'c', priority: 'P2', liveState: 'idle', sessionDetails: [{ projectName: 'web' }] },
  { id: 'd', priority: 'P1', liveState: 'waiting', sessionDetails: [{ workingDir: '/x/y/mixread' }] },
  { id: 'e', priority: 'P3', liveState: 'completed', sessionDetails: [] }, // 无项目
]

test('project 维度：同项目归桶，无项目沉底', () => {
  const g = groupTasks(tasks, 'project')
  const keys = g.map((x) => x.key)
  // web 出现最早 → 排首；(无项目) 永远最后
  assert.equal(keys[0], 'web')
  assert.equal(keys[keys.length - 1], '(无项目)')
  const web = g.find((x) => x.key === 'web')
  assert.deepEqual(web.items.map((t) => t.id), ['a', 'c'])
  // workingDir 兜底取末段目录名
  assert.ok(keys.includes('mixread'))
})

test('status 维度：组顺序 waiting → running → idle → completed', () => {
  const g = groupTasks(tasks, 'status')
  assert.deepEqual(g.map((x) => x.key), ['waiting', 'running', 'idle', 'completed'])
  assert.deepEqual(
    g.find((x) => x.key === 'waiting').items.map((t) => t.id),
    ['b', 'd']
  )
})

test('priority 维度：P0 置顶，按 P0→P3', () => {
  const g = groupTasks(tasks, 'priority')
  assert.deepEqual(g.map((x) => x.key), ['P0', 'P1', 'P2', 'P3'])
})

test('countByState 聚合各 liveState 计数', () => {
  assert.deepEqual(countByState(tasks), {
    waiting: 2,
    running: 1,
    idle: 1,
    completed: 1,
  })
})

test('projectOf 兜底链：projectName → workingDir basename → (无项目)', () => {
  assert.equal(projectOf({ sessionDetails: [{ projectName: 'foo' }] }), 'foo')
  assert.equal(projectOf({ sessionDetails: [{ workingDir: '/a/b/bar' }] }), 'bar')
  assert.equal(projectOf({ sessionDetails: [] }), '(无项目)')
})

test('workingDirOf 取 session 的真实目录', () => {
  assert.equal(workingDirOf({ sessionDetails: [{ workingDir: '/a/b/bar' }] }), '/a/b/bar')
  assert.equal(workingDirOf({ workingDir: '/c/d' }), '/c/d')
  assert.equal(workingDirOf({ sessionDetails: [] }), '')
})

test('project 维度：组带代表性 workingDir，(无项目) 组为空（开新会话的 cwd 来源）', () => {
  const ts = [
    { id: 'a', sessionDetails: [{ projectName: 'web', workingDir: '/repo/web' }] },
    { id: 'b', sessionDetails: [{ projectName: 'web', workingDir: '/repo/web' }] },
    { id: 'c', sessionDetails: [{ projectName: 'api', workingDir: '/repo/api' }] },
    { id: 'd', sessionDetails: [] }, // 无项目 → 沉底，无目录
  ]
  const g = groupTasks(ts, 'project')
  const web = g.find((x) => x.key === 'web')
  const api = g.find((x) => x.key === 'api')
  const none = g.find((x) => x.key === '(无项目)')
  assert.equal(web.workingDir, '/repo/web')
  assert.equal(api.workingDir, '/repo/api')
  assert.equal(none.workingDir, '') // 无目录不给「＋ 新会话」入口
})
