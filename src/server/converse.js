import { spawn } from 'node:child_process'
import { unlink, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessions, persist } from './store.js'
import { broadcast } from './bus.js'
import { getConfig } from './config.js'
import { findSessionFile } from './transcript.js'
import { upsertFromAgent } from './tasks.js'

// 正在进行的网页续话：claudeSessionId -> child process
const inflight = new Map()

const UPLOAD_DIR = join(tmpdir(), 'commander-uploads')
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// 把前端传来的 base64 data URL 图片落到临时文件，返回绝对路径数组（供 @path 引用）。
// 文件名无空格，避免 @path 在 prompt 里按空格切断。caller 负责在续话结束后清理（sendMessage 已处理）。
export async function saveUploads(images = []) {
  if (!images.length) return []
  await mkdir(UPLOAD_DIR, { recursive: true })
  const paths = []
  for (let i = 0; i < images.length; i++) {
    const url = images[i]?.dataUrl || ''
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(url)
    if (!m) continue
    const ext = EXT_BY_MIME[m[1].toLowerCase()] || 'png'
    const name = `up-${process.pid}-${seq++}-${i}.${ext}`
    const abs = join(UPLOAD_DIR, name)
    await writeFile(abs, Buffer.from(m[2], 'base64'))
    paths.push(abs)
  }
  return paths
}
let seq = 0

// stream-json 的 init/system 事件里带本次会话的 session_id（claude 原生 & ccr 透传均如此）。
// 抽成纯函数便于回归（test/converse.test.mjs）：返回 session_id 或 null。
export function extractSessionId(ev) {
  if (!ev || typeof ev !== 'object') return null
  // 原生 claude：{ type:'system', subtype:'init', session_id:'...' }
  // 兜底：任何携带 session_id 的事件都认（首个非空即可）
  return ev.session_id || ev.sessionId || null
}

// 解析 stream-json 的一行，抽取要推给前端的增量
// onSession：可选，遇到带 session_id 的事件时回调（新建会话用来纳管，续话不传）
function parseStreamLine(line, onText, onResult, onSession) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  if (onSession) {
    const sid = extractSessionId(ev)
    if (sid) onSession(sid)
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
// imagePaths：可选的图片绝对路径数组，以 @path 形式拼进 prompt（ccr 已验证支持多模态透传）
// 返回 { ok, error }；过程通过 ws 推送 type:'converse' 增量
export function sendMessage(claudeSessionId, text, imagePaths = []) {
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
  // 图片以 @绝对路径 拼到 prompt 末尾，ccr/claude 会读取并以多模态送给视觉模型
  const refs = (imagePaths || []).map((p) => `@${p}`).join(' ')
  const prompt = refs ? (text ? `${text}\n${refs}` : refs) : text

  const args = [
    ...baseArgs,
    '-p',
    prompt,
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
  // -p 模式默认等 stdin（会白等 ~3s 再继续），我们没有 stdin 输入，立即关闭
  child.stdin?.end()
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
    // 清理本轮上传的临时图片（失败忽略）
    for (const p of imagePaths || []) unlink(p).catch(() => {})
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

// 正在启动中的「网页新建会话」：workingDir -> child（开始时还没有 sessionId，按目录单飞）
const starting = new Map()

// 网页内启动全新 session（不带 --resume）：在 workingDir 下
// `<launcher> -p <text> --output-format stream-json --verbose`。
// 从 stream-json 首个带 session_id 的事件捕获新会话 id → upsertFromAgent 立即入队（秒级，
// 不靠 scanner 兜底）；增量复用 ws type:'converse' 通道推前端。
// 返回 { ok, status, error }；过程异步，session_id 拿到后才有 sid。
export function startSession({ workingDir, text } = {}) {
  const cwd = (workingDir || '').trim()
  const prompt = (text || '').trim()
  if (!cwd) return { ok: false, status: 400, error: '缺少项目目录' }
  if (!prompt) return { ok: false, status: 400, error: '消息为空' }

  // 同目录单飞：防误连点开两个
  if (starting.has(cwd)) {
    return { ok: false, status: 409, error: '该目录已有一个新会话正在启动中' }
  }

  const baseCmd = getConfig().cmdTemplate || ''
  // 与续话同源：取 --resume 之前的部分作为启动器前缀
  const launcher = baseCmd.split('--resume')[0].trim() || 'ccr code'
  const argv = launcher.split(/\s+/)
  const bin = argv[0]
  const baseArgs = argv.slice(1)

  const args = [...baseArgs, '-p', prompt, '--output-format', 'stream-json', '--verbose']

  const child = spawn(bin, args, { cwd, env: process.env })
  child.stdin?.end()
  starting.set(cwd, child)

  let buf = ''
  let sid = null
  let finalResult = null

  // 捕获到 session_id：纳管入队 + 把 inflight 键补成 sid + 广播 start
  const onSession = (newSid) => {
    if (sid) return
    sid = newSid
    inflight.set(sid, child)
    upsertFromAgent({
      claudeSessionId: sid,
      workingDir: cwd,
      projectRoot: cwd,
      projectName: cwd.split(/[\\/]+/).filter(Boolean).pop() || null,
      source: 'hook',
      liveState: 'running',
      eventAt: Date.now(),
    })
    broadcast({ type: 'converse', sid, phase: 'start' })
  }

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      parseStreamLine(
        line,
        (t) => sid && broadcast({ type: 'converse', sid, phase: 'delta', text: t }),
        (r) => {
          finalResult = r
        },
        onSession
      )
    }
  })

  child.stderr.on('data', () => {
    /* ccr deprecation 噪音等，忽略 */
  })

  const finish = (extra = {}) => {
    starting.delete(cwd)
    if (sid) {
      inflight.delete(sid)
      const { sessions } = getSessions()
      const s = sessions.find((x) => x.claudeSessionId === sid)
      if (s) {
        // 新建会话跑完 → 大概率在等你
        s.liveState = 'waiting'
        s.lastEventAt = Date.now()
        persist('sessions')
      }
      broadcast({
        type: 'converse',
        sid,
        phase: 'done',
        result: finalResult?.result || '',
        ok: finalResult?.ok ?? true,
        ...extra,
      })
    }
  }

  child.on('close', () => finish())
  child.on('error', (err) => finish({ ok: false, error: err.message }))

  // 兜底超时（5 分钟）
  setTimeout(
    () => {
      if (starting.get(cwd) === child) child.kill('SIGTERM')
    },
    5 * 60 * 1000
  )

  return { ok: true, status: 200 }
}

export function isBusy(claudeSessionId) {
  return inflight.has(claudeSessionId)
}
