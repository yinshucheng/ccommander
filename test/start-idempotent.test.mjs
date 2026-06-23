// 回归测试：start.sh 幂等重启。
// 验证「重跑同一条 start.sh 命令会自动杀掉端口上的旧 commander 再起新的」——
// 这是「改了后端代码 → 重跑 start.sh 换新进程」的核心不变量，也是修过的坑：
// 早期后台模式只靠 pid 文件判重，检测不到前台起的（无 pid 文件）旧进程，
// 导致重跑要么报「已在跑」拒绝、要么端口冲突。现在靠端口定位，前台/后台都能覆盖。
//
// 不测 --stop / 非误杀等其余分支（手动 happy-path 已覆盖），只钉死幂等重启这一条。
import { spawnSync, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const START = path.join(ROOT, 'start.sh')
const PORT = 4891 // 用一个平时不用的端口，避免和真实 3890 撞
const ENV = 'idemtest'
const PID_FILE = `/tmp/commander-${ENV}.pid`

function clean() {
  // 停掉可能残留的本测试进程
  if (existsSync(PID_FILE)) {
    try {
      const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
      if (pid) process.kill(pid)
    } catch { /* 已不在 */ }
    try { unlinkSync(PID_FILE) } catch {}
  }
  // 端口上残留的 commander 也清掉
  const r = spawnSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  for (const pid of (r.stdout || '').split('\n').filter(Boolean)) {
    try { process.kill(Number(pid)) } catch {}
  }
}

// 跑一次 start.sh --bg，返回 { pid, stdout }
async function runBg() {
  const p = spawn('bash', [START, '--background', '--env', ENV, '--no-open', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  await new Promise((r) => p.on('close', r))
  const pid = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8').trim()) : NaN
  return { pid, out }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function httpUp() {
  try {
    const res = await fetch(`http://localhost:${PORT}/`)
    return res.ok
  } catch { return false }
}

// 等 HTTP 就绪，最多 ~5s
async function waitUp() {
  for (let i = 0; i < 20; i++) {
    if (await httpUp()) return true
    await sleep(250)
  }
  return false
}

let first, second
try {
  clean()
  await sleep(300)

  // 1) 首次后台启动
  first = await runBg()
  assert.ok(first.pid, `首次启动应落 pid 文件。输出:\n${first.out}`)
  assert.ok(await waitUp(), `首次启动后 HTTP 应就绪。输出:\n${first.out}`)

  // 2) 同命令重跑 → 幂等：杀旧起新
  await sleep(300)
  second = await runBg()
  assert.ok(second.pid, `二次启动应落 pid 文件。输出:\n${second.out}`)
  assert.notEqual(second.pid, first.pid, `重跑后 pid 必须换新 (${first.pid} → ${second.pid})`)
  assert.ok(!alive(first.pid), `旧 pid ${first.pid} 必须已被杀掉`)
  assert.ok(alive(second.pid), `新 pid ${second.pid} 必须活着`)
  assert.ok(await waitUp(), `换新进程后 HTTP 应仍就绪`)

  console.log(`✓ 幂等重启: ${first.pid} → ${second.pid}（旧进程已死、新进程活着、HTTP 200）`)
} finally {
  clean()
}
