// hook-server.js 单测（第 2 项）。
// 重点：进程级 hook server 的端到端 — 写 settings 文件 / 启动 server / curl 推事件 /
// subscribe 回调收到正确数据。
//
// 不变量：
//   ① writeHookSettings 写出的 JSON 含 SessionStart/Stop/Notification 三类 hook
//   ② Notification 只接 idle_prompt / permission_prompt 两个 matcher（与全局 hook 一致）
//   ③ startProcHookServer + subscribe('*') 能收到 POST /hook/session-start，按 session_id 分发
//   ④ 重复 startProcHookServer 返回同一端口（共享 server）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'

import { after } from 'node:test'
import {
  startProcHookServer,
  writeHookSettings,
  cleanupHookSettings,
  subscribe,
  _closeForTest,
} from '../src/server/hook-server.js'

after(() => _closeForTest())

test('writeHookSettings: 含三类 hook + Notification 只接两个 matcher', () => {
  const path = writeHookSettings(12345, 'unit-test')
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(settings.hooks.SessionStart, 'SessionStart 存在')
    assert.ok(settings.hooks.Stop, 'Stop 存在')
    assert.ok(Array.isArray(settings.hooks.Notification), 'Notification 是数组')
    const matchers = settings.hooks.Notification.map((g) => g.matcher).sort()
    assert.deepEqual(matchers, ['idle_prompt', 'permission_prompt'])
    // hook command 应包含目标 URL
    const cmd = settings.hooks.SessionStart[0].hooks[0].command
    assert.match(cmd, /127\.0\.0\.1:12345\/hook\/session-start/)
  } finally {
    cleanupHookSettings(path)
  }
})

test('startProcHookServer 重复调用返回同一端口（共享 server）', async () => {
  const p1 = await startProcHookServer()
  const p2 = await startProcHookServer()
  assert.equal(p1, p2)
  assert.ok(p1 > 0)
})

// 用 node:http POST 模拟 curl 推一条 SessionStart 进去，看 subscribe 能否收到
function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

test('subscribe: 通配 + 具体 sid 都能收到 POST /hook/session-start', async () => {
  const port = await startProcHookServer()
  let wildHit = null
  let specHit = null
  const unsubWild = subscribe('*', { onSessionStart: (sid, data) => (wildHit = { sid, data }) })
  const unsubSpec = subscribe('sid-xyz', {
    onSessionStart: (sid, data) => (specHit = { sid, data }),
  })
  try {
    const res = await postJson(port, '/hook/session-start', {
      session_id: 'sid-xyz',
      cwd: '/tmp/proj',
    })
    assert.equal(res.status, 200)
    // 给 dispatch 一点时间（同步派发，但 promise 链需要让出）
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(wildHit?.sid, 'sid-xyz', '通配 listener 收到了')
    assert.equal(specHit?.sid, 'sid-xyz', '具体 sid listener 也收到了')
    assert.equal(wildHit?.data?.cwd, '/tmp/proj', 'data 透传 cwd 等字段')
  } finally {
    unsubWild()
    unsubSpec()
  }
})

test('未知路径返回 404', async () => {
  const port = await startProcHookServer()
  const res = await postJson(port, '/hook/bogus', {})
  assert.equal(res.status, 404)
})
