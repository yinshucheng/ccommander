import { spawn } from 'node:child_process'
import { getSessions, persist } from './store.js'
import { broadcast } from './bus.js'
import { getConfig } from './config.js'
import { findSessionFile } from './transcript.js'

// 正在进行的网页续话：claudeSessionId -> child process
const inflight = new Map()

// 解析 stream-json 的一行，抽取要推给前端的增量
function parseStreamLine(line, onText, onResult) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  if (ev.type === 'assistant') {
    const parts = ev.message?.content || []
    for (const p of parts) {
      if (p.type === 'text' && p.text) onText(p.text)
      else if (p.type === 'tool_use') onText(`\n[调用工具: ${p.name}]\n`)
    }
  } else if (ev.type === 'result') {
    onResult({ ok: !ev.is_error, result: ev.result || '', error: ev.errors?.[0] || null })
  }
}

// 网页续话：在会话自己的 workingDir 下 `ccr code -p <text> --resume <sid> --output-format stream-json`
// 返回 { ok, error }；过程通过 ws 推送 type:'converse' 增量
export function sendMessage(claudeSessionId, text) {
  const { sessions } = getSessions()
  const session = sessions.find(
    (s) => s.claudeSessionId === claudeSessionId || s.sessionId === claudeSessionId
  )
  if (!session) return { ok: false, status: 404, error: '找不到该会话' }

  // 并发保护：running 可能有活终端，禁止网页注入
  if (session.liveState === 'running') {
    return { ok: false, status: 409, error: '该会话可能正在终端运行，已禁止网页续话' }
  }
  if (inflight.has(claudeSessionId)) {
    return { ok: false, status: 409, error: '该会话已有一条网页消息在处理中' }
  }

  const file = findSessionFile(claudeSessionId)
  if (!file) return { ok: false, status: 404, error: '找不到 transcript（无法定位会话）' }

  const cwd = session.workingDir || process.cwd()
  const baseCmd = getConfig().cmdTemplate || ''
  // 从模板里提取启动器（取 {sessionId} 之前的部分作为命令前缀，如 "ccr code --dangerously-skip-permissions"）
  const launcher = baseCmd.split('--resume')[0].trim() || 'ccr code'
  const argv = launcher.split(/\s+/)
  const bin = argv[0]
  const baseArgs = argv.slice(1)
  const args = [
    ...baseArgs,
    '-p',
    text,
    '--resume',
    claudeSessionId,
    '--output-format',
    'stream-json',
    '--verbose',
  ]

  // 标记会话为运行中（网页发起），让 UI 即时反馈
  session.liveState = 'running'
  session.webBusy = true
  persist('sessions')
  broadcast({ type: 'converse', sid: claudeSessionId, phase: 'start' })

  const child = spawn(bin, args, { cwd, env: process.env })
  inflight.set(claudeSessionId, child)

  let buf = ''
  let finalResult = null

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      parseStreamLine(
        line,
        (t) => broadcast({ type: 'converse', sid: claudeSessionId, phase: 'delta', text: t }),
        (r) => {
          finalResult = r
        }
      )
    }
  })

  child.stderr.on('data', () => {
    /* ccr 的 deprecation 噪音等，忽略 */
  })

  const finish = (extra = {}) => {
    inflight.delete(claudeSessionId)
    session.webBusy = false
    // 续话完成 → 大概率又在等你了
    session.liveState = 'waiting'
    session.lastEventAt = Date.now()
    persist('sessions')
    broadcast({
      type: 'converse',
      sid: claudeSessionId,
      phase: 'done',
      result: finalResult?.result || '',
      ok: finalResult?.ok ?? true,
      ...extra,
    })
  }

  child.on('close', () => finish())
  child.on('error', (err) => finish({ ok: false, error: err.message }))

  // 兜底超时（5 分钟）
  setTimeout(
    () => {
      if (inflight.get(claudeSessionId) === child) {
        child.kill('SIGTERM')
      }
    },
    5 * 60 * 1000
  )

  return { ok: true, status: 200 }
}

export function isBusy(claudeSessionId) {
  return inflight.has(claudeSessionId)
}
