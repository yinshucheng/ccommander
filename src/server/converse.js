import { spawn } from 'node:child_process'
import { unlink, mkdir, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSessions, persist } from './store.js'
import { broadcast } from './bus.js'
import { getConfig } from './config.js'
import { findSessionFile } from './transcript.js'
import { upsertFromAgent } from './tasks.js'
import { templateSkipsPermissions, buildUserMessage } from './permission.js'
import { getToken, getInternalUrl, failPendingForSession } from './perm-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PERM_SERVER = join(__dirname, 'perm-server.js')

// 长驻续话进程注册表（spec 015）：claudeSessionId -> { child, buf, cwd, idleTimer, mcpConfigPath }
// 进程随会话存活，多轮共享同一进程/上下文；空闲超时回收。一步到位上长驻模型，为 L3 铺路。
const procs = new Map()

const UPLOAD_DIR = join(tmpdir(), 'commander-uploads')
const MCP_DIR = join(tmpdir(), 'commander-mcp')
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// 空闲多久回收长驻进程（无新消息）
const IDLE_KILL_MS = 10 * 60 * 1000

// 把前端传来的 base64 data URL 图片落到临时文件，返回绝对路径数组（供 @path 引用）。
// 文件名无空格，避免 @path 在 prompt 里按空格切断。caller 负责在续话结束后清理。
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
  return ev.session_id || ev.sessionId || null
}

// 解析 stream-json 的一行，抽取要推给前端的增量。
// onSession：可选，遇到带 session_id 的事件时回调（新建会话用来纳管）。
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

// 从 cmdTemplate 取启动器前缀（--resume 之前），如 "ccr code --dangerously-skip-permissions"。
function launcherFromTemplate() {
  const baseCmd = getConfig().cmdTemplate || ''
  return baseCmd.split('--resume')[0].trim() || 'ccr code'
}

// 为一个会话生成临时 mcp-config（指向内置 perm-server），返回配置文件路径。
// perm-server 经环境变量拿到回连 URL/token/sid。仅在「不跳过权限」时调用。
function writeMcpConfig(sid) {
  mkdirSync(MCP_DIR, { recursive: true })
  const cfg = {
    mcpServers: {
      commander: {
        command: process.execPath, // 当前 node
        args: [PERM_SERVER],
        env: {
          COMMANDER_PERM_URL: getInternalUrl(),
          COMMANDER_PERM_TOKEN: getToken(),
          COMMANDER_PERM_SID: sid,
        },
      },
    },
  }
  const path = join(MCP_DIR, `mcp-${sid.replace(/[^\w.-]/g, '_')}.json`)
  writeFileSync(path, JSON.stringify(cfg))
  return path
}

// 组装长驻进程的 argv。返回 { bin, args, mcpConfigPath|null }。
// 放行派生自 cmdTemplate：含 skip → 不挂 perm 工具（沿用现状全放行，实测 skip 下 perm
// 工具根本不被调用）；不含 skip → 挂 perm 工具 + --permission-mode default（交互审批）。
function buildArgs(sid) {
  const argv = launcherFromTemplate().split(/\s+/)
  const bin = argv[0]
  const baseArgs = argv.slice(1)
  const args = [
    ...baseArgs,
    '--resume',
    sid,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
  let mcpConfigPath = null
  if (!templateSkipsPermissions(getConfig().cmdTemplate || '')) {
    mcpConfigPath = writeMcpConfig(sid)
    args.push(
      '--permission-mode',
      'default',
      '--mcp-config',
      mcpConfigPath,
      '--permission-prompt-tool',
      'mcp__commander__approve'
    )
  }
  return { bin, args, mcpConfigPath }
}

function resetIdleTimer(sid) {
  const rec = procs.get(sid)
  if (!rec) return
  if (rec.idleTimer) clearTimeout(rec.idleTimer)
  rec.idleTimer = setTimeout(() => killProc(sid, 'idle'), IDLE_KILL_MS)
  if (rec.idleTimer.unref) rec.idleTimer.unref()
}

function killProc(sid, reason = '') {
  const rec = procs.get(sid)
  if (!rec) return
  procs.delete(sid)
  if (rec.idleTimer) clearTimeout(rec.idleTimer)
  // 进程没了，把它名下所有挂起的权限请求 deny 掉，避免 perm-server 永久等待
  failPendingForSession(sid, `process ended (${reason})`)
  if (rec.mcpConfigPath) unlink(rec.mcpConfigPath).catch(() => {})
  try {
    rec.child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
}

// 确保会话有一个活的长驻进程；没有则 spawn。返回进程记录。
function ensureProc(sid, cwd) {
  const existing = procs.get(sid)
  if (existing && !existing.child.killed) return existing

  const { bin, args, mcpConfigPath } = buildArgs(sid)
  const child = spawn(bin, args, { cwd, env: process.env })
  const rec = { child, buf: '', cwd, idleTimer: null, mcpConfigPath }
  procs.set(sid, rec)

  child.stdout.on('data', (chunk) => {
    rec.buf += chunk.toString()
    let idx
    while ((idx = rec.buf.indexOf('\n')) >= 0) {
      const line = rec.buf.slice(0, idx)
      rec.buf = rec.buf.slice(idx + 1)
      if (!line.trim()) continue
      parseStreamLine(
        line,
        (t) => broadcast({ type: 'converse', sid, phase: 'delta', text: t }),
        (r) => {
          // 一轮 result：会话大概率又在等你
          const { sessions } = getSessions()
          const s = sessions.find((x) => x.claudeSessionId === sid || x.sessionId === sid)
          if (s) {
            s.webBusy = false
            s.liveState = 'waiting'
            s.lastEventAt = Date.now()
            persist('sessions')
          }
          broadcast({ type: 'converse', sid, phase: 'done', result: r.result || '', ok: r.ok })
        }
      )
    }
  })
  child.stderr.on('data', () => {
    /* ccr deprecation 噪音等，忽略 */
  })
  child.on('close', () => killProc(sid, 'close'))
  child.on('error', (err) => {
    broadcast({ type: 'converse', sid, phase: 'done', ok: false, error: err.message })
    killProc(sid, 'error')
  })

  return rec
}

// 网页续话：向会话的长驻进程 stdin 喂一条 user 消息（stream-json 输入）。
// imagePaths：可选图片绝对路径，以 @path 形式拼进文本（ccr/claude 多模态读取）。
// 返回 { ok, status, error }；过程通过 ws 推 type:'converse' 增量。
export function sendMessage(claudeSessionId, text, imagePaths = []) {
  const { sessions } = getSessions()
  const session = sessions.find(
    (s) => s.claudeSessionId === claudeSessionId || s.sessionId === claudeSessionId
  )
  if (!session) return { ok: false, status: 404, error: '找不到该会话' }

  // 保护：别处（真终端等别的写入方）正在写同一会话、且我们并未持有它的长驻进程时，
  // 禁止注入（避免两个写入方打架）。我们自己持有的长驻进程不算「别处」——长驻下网页
  // 自己就是那个活进程，允许继续注入（这是相对旧 spec 的 running 保护重定义）。
  if (session.liveState === 'running' && !procs.has(claudeSessionId)) {
    return { ok: false, status: 409, error: '该会话可能正在终端运行，已禁止网页续话' }
  }

  const file = findSessionFile(claudeSessionId)
  if (!file) return { ok: false, status: 404, error: '找不到 transcript（无法定位会话）' }

  const cwd = session.workingDir || process.cwd()

  let rec
  try {
    rec = ensureProc(claudeSessionId, cwd)
  } catch (e) {
    return { ok: false, status: 500, error: `启动续话进程失败: ${e.message}` }
  }

  // 标记运行中（网页发起）
  session.liveState = 'running'
  session.webBusy = true
  persist('sessions')
  broadcast({ type: 'converse', sid: claudeSessionId, phase: 'start' })

  // 图片以 @绝对路径 拼到文本末尾
  const refs = (imagePaths || []).map((p) => `@${p}`).join(' ')
  const finalText = refs ? (text ? `${text}\n${refs}` : refs) : text
  const msg = buildUserMessage(finalText)

  try {
    rec.child.stdin.write(JSON.stringify(msg) + '\n')
  } catch (e) {
    killProc(claudeSessionId, 'stdin-error')
    return { ok: false, status: 500, error: `写入续话进程失败: ${e.message}` }
  }
  resetIdleTimer(claudeSessionId)
  // 本轮临时图片延迟清理（已喂给子进程读取）
  for (const p of imagePaths || []) setTimeout(() => unlink(p).catch(() => {}), 60 * 1000)

  return { ok: true, status: 200 }
}

// 正在启动中的「网页新建会话」：workingDir -> child（开始时还没有 sessionId）
const starting = new Map()

// 网页内启动全新 session（不带 --resume）。新建仍用 -p 单轮拿 session_id 入队（spec 013
// 秒级入队），拿到 sid 后续轮由长驻 sendMessage 接管。
export function startSession({ workingDir, text } = {}) {
  const cwd = (workingDir || '').trim()
  const prompt = (text || '').trim()
  if (!cwd) return { ok: false, status: 400, error: '缺少项目目录' }
  if (!prompt) return { ok: false, status: 400, error: '消息为空' }
  if (starting.has(cwd)) {
    return { ok: false, status: 409, error: '该目录已有一个新会话正在启动中' }
  }

  const argv = launcherFromTemplate().split(/\s+/)
  const bin = argv[0]
  const baseArgs = argv.slice(1)
  const args = [...baseArgs, '-p', prompt, '--output-format', 'stream-json', '--verbose']

  const child = spawn(bin, args, { cwd, env: process.env })
  child.stdin?.end()
  starting.set(cwd, child)

  let buf = ''
  let sid = null
  let finalResult = null

  const onSession = (newSid) => {
    if (sid) return
    sid = newSid
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
  child.stderr.on('data', () => {})

  const finish = (extra = {}) => {
    starting.delete(cwd)
    if (sid) {
      const { sessions } = getSessions()
      const s = sessions.find((x) => x.claudeSessionId === sid)
      if (s) {
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

  setTimeout(() => {
    if (starting.get(cwd) === child) child.kill('SIGTERM')
  }, 5 * 60 * 1000)

  return { ok: true, status: 200 }
}

export function isBusy(claudeSessionId) {
  return procs.has(claudeSessionId)
}

// 会话被 dismiss/done 时回收其长驻进程（index/tasks 可调用）
export function endConverse(claudeSessionId, reason = 'ended') {
  killProc(claudeSessionId, reason)
}
