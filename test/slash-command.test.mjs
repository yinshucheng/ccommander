// 斜杠命令分发器分类逻辑（不真 spawn 进程；只验路由 + 错误兜底）
import test from 'node:test'
import assert from 'node:assert/strict'
import { init, getSessions, persist } from '../src/server/store.js'
import { slashCommand, PASSTHROUGH_SLASH, SIMULATED_SLASH } from '../src/server/converse.js'
import { upsertFromAgent } from '../src/server/tasks.js'

init()

// 给后续 case 们都加一个测试用 session（同一个 sid 复用，便于清理）
const SID = `slash-test-${Date.now()}`
function ensureSid(sid = SID) {
  upsertFromAgent({
    claudeSessionId: sid,
    workingDir: '/tmp',
    projectRoot: '/tmp',
    source: 'hook',
    eventAt: Date.now(),
  })
}
function cleanup() {
  const { sessions } = getSessions()
  const idx = sessions.findIndex((s) => s.claudeSessionId === SID || (s.claudeSessionId || '').startsWith('slash-test-'))
  if (idx >= 0) sessions.splice(idx, 1)
  persist('sessions')
}

test('未知会话 → 404', () => {
  const r = slashCommand('does-not-exist-' + Date.now(), '/compact')
  assert.equal(r.ok, false)
  assert.equal(r.status, 404)
})

test('非斜杠输入 → 400', () => {
  const r = slashCommand('anything', 'not a slash')
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.match(r.error, /不是斜杠命令/)
})

test('TTY-only 命令明确拒收 + 文案提示原生终端', () => {
  ensureSid()
  for (const c of ['/model', '/help', '/resume', '/init', '/memory']) {
    const r = slashCommand(SID, c)
    assert.equal(r.ok, false, `${c} 应被拒`)
    assert.match(r.error, /原生终端/, `${c} 应提示原生终端: ${r.error}`)
  }
  cleanup()
})

test('未知 /xxx → 列出网页支持的清单', () => {
  ensureSid()
  const r = slashCommand(SID, '/totally-made-up')
  assert.equal(r.ok, false)
  assert.match(r.error, /未知斜杠命令/)
  assert.match(r.error, /\/compact/)
  assert.match(r.error, /\/plan/)
  cleanup()
})

test('白名单互斥（避免后续维护漂移）', () => {
  assert.ok(PASSTHROUGH_SLASH.has('/compact'))
  assert.ok(PASSTHROUGH_SLASH.has('/usage'))
  assert.ok(SIMULATED_SLASH.has('/plan'))
  assert.ok(SIMULATED_SLASH.has('/clear'))
  for (const c of PASSTHROUGH_SLASH) {
    assert.ok(!SIMULATED_SLASH.has(c), `${c} 同时出现在两份白名单`)
  }
})

test('/plan 把 session.permissionMode 置为 plan（即便后续 sendMessage 失败也已持久化）', () => {
  ensureSid()
  let { sessions } = getSessions()
  let s = sessions.find((x) => x.claudeSessionId === SID)
  assert.equal(s?.permissionMode, undefined, '初始不应有 permissionMode')
  // 调用：/plan 内部会调 sendMessage，没真 transcript 会失败，但 permissionMode 已先写
  slashCommand(SID, '/plan 把这个文件分析一下')
  ;({ sessions } = getSessions())
  s = sessions.find((x) => x.claudeSessionId === SID)
  assert.equal(s?.permissionMode, 'plan', 'permissionMode 应被置为 plan')
  cleanup()
})
