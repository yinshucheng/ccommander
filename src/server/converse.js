import crossSpawn from 'cross-spawn'
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
import {
  startProcHookServer,
  writeHookSettings,
  cleanupHookSettings,
  subscribe as subscribeHook,
} from './hook-server.js'
import { reassignSession, recordAlias, resolveAlias } from './session-alias.js'

const spawn = crossSpawn

const __dirname = dirname(fileURLToPath(import.meta.url))
const PERM_SERVER = join(__dirname, 'perm-server.js')

// 长驻续话进程注册表（spec 015）：claudeSessionId -> { child, buf, cwd, idleTimer, mcpConfigPath }
// 进程随会话存活，多轮共享同一进程/上下文；空闲超时回收。一步到位上长驻模型，为 L3 铺路。
const procs = new Map()

// 进程级 hook server 端口缓存：第一次 spawn 时启动（lazy），后续 spawn 复用。
// 0 = 还没启动；-1 = 启动失败（降级为不传 --settings，仍走全局 hook 兜底）。
// 不在模块顶层 spawn server —— 否则 import converse.js（测试场景）会留下监听 socket
// 让 node --test 永远不退出。startServer() 在 listen 完成后主动调一次 warmHookServer()。
let hookPort = 0
let hookWarmPromise = null
export function warmHookServer() {
  if (hookPort || hookWarmPromise) return hookWarmPromise || Promise.resolve(hookPort)
  hookWarmPromise = startProcHookServer()
    .then((p) => {
      hookPort = p
      return p
    })
    .catch(() => {
      hookPort = -1
      return -1
    })
  return hookWarmPromise
}

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
//
// 事件来源分两路：
//   ① 不带 --include-partial-messages 时：只有 `assistant`（整段）+ `result`。整段一次性
//      推 onText（用户感受到"卡顿后整段蹦出"，TTFT 损失 1–2s）。
//   ② 带 --include-partial-messages 时：claude 多发 `stream_event` 包着 Anthropic 原生
//      事件（message_start / content_block_delta / message_delta / message_stop），逐字
//      流。我们只消费 `text_delta`，整段 `assistant` 在 partial 模式下要**跳过**，避免
//      "先逐字打字，再整段重复"。
//
// 用一个标记 `sawPartialThisTurn` 来区分这一轮是 partial 还是非 partial：见到任意
// stream_event 即认定本轮 partial，后续 `assistant` 不再推 onText（防重复）；result
// 重置标记。靠 onResult 调用方传 reset 闭包不优雅，干脆做成模块级状态，按 sid 隔离。
const partialState = new Map() // sid -> { sawPartial: boolean }

function getPartialState(sid) {
  let s = partialState.get(sid)
  if (!s) {
    s = { sawPartial: false }
    partialState.set(sid, s)
  }
  return s
}

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
  // 逐字流：partial 模式下的 text_delta —— 这才是用户期望的"打字机"
  if (ev.type === 'stream_event') {
    const sid = extractSessionId(ev)
    if (sid) getPartialState(sid).sawPartial = true
    const e = ev.event
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
      onText(e.delta.text)
    }
    return
  }
  if (ev.type === 'assistant') {
    const sid = extractSessionId(ev)
    // partial 模式下整段 `assistant` 是重复内容，跳过文本但保留 tool_use 提示
    const skipText = sid ? getPartialState(sid).sawPartial : false
    const parts = ev.message?.content || []
    for (const p of parts) {
      if (p.type === 'text' && p.text && !skipText) {
        onText(p.text)
      } else if (p.type === 'tool_use') {
        onText(`\n[调用工具: ${p.name}]\n`)
      }
    }
  } else if (ev.type === 'result') {
    const sid = extractSessionId(ev)
    if (sid) partialState.delete(sid) // 本轮结束，清状态
    onResult({ ok: !ev.is_error, result: ev.result || '', error: ev.errors?.[0] || null })
  }
}

// 从 cmdTemplate 取启动器前缀（--resume 之前），如 "ccr code --dangerously-skip-permissions"。
function launcherFromTemplate() {
  const baseCmd = getConfig().cmdTemplate || ''
  return baseCmd.split('--resume')[0].trim() || 'ccr code'
}

// 当前 cmdTemplate 是否走 ccr（claude-code-router）。
// ccr 会把 --settings 截胡：它把我们传的路径和它自己的 ccr-settings 路径打包成数组
// 交给底层 claude，claude 拒收 → 子进程立刻退出（"Settings file not found"）。
// 实测复现：手工跑同样的 argv 报 Settings file not found: [/our/path, /ccr/path]。
// 所以走 ccr 时**绝对不能注入 --settings** —— 退避到全局 hook 兜底（commander-emit.sh）。
export function templateUsesCcr(tpl = '') {
  const first = String(tpl).trim().split(/\s+/)[0] || ''
  return first === 'ccr'
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

// 组装长驻进程的 argv。返回 { bin, args, mcpConfigPath|null, hookSettingsPath|null }。
// 放行派生自 cmdTemplate：含 skip → 不挂 perm 工具（沿用现状全放行，实测 skip 下 perm
// 工具根本不被调用）；不含 skip → 挂 perm 工具 + --permission-mode default（交互审批）。
// 如果 hook server 已启动，再叠加 --settings <临时 settings 文件>，让 hook 直接 POST
// 回我们自己进程（精准到 spawn 的这一个 claude；详见 hook-server.js 注释）。
// opts.skipHookSettings: 早夭重试时去掉 --settings（怀疑是它把 ccr/claude 噎住）
// opts.permissionMode: 'plan' 时强制带 --permission-mode plan（即便模板带 skip 也加）
//   —— 这是斜杠 /plan 的实现路径：commander 端模拟，下一轮以 plan 模式重 spawn。
function buildArgs(sid, opts = {}) {
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
  // B-1：逐字流。早夭退避路径下去掉它，怀疑老 ccr 不识别这个 flag 会噎住。
  // 第二次重启时如果早夭过、且 skipPartial 没被显式标记，就降级到非 partial。
  if (!opts.skipPartial) {
    args.push('--include-partial-messages')
  }
  let mcpConfigPath = null
  if (!templateSkipsPermissions(getConfig().cmdTemplate || '')) {
    mcpConfigPath = writeMcpConfig(sid)
    args.push(
      '--permission-mode',
      opts.permissionMode || 'default',
      '--mcp-config',
      mcpConfigPath,
      '--permission-prompt-tool',
      'mcp__commander__approve'
    )
  } else if (opts.permissionMode === 'plan') {
    // 模板带 skip 但用户走了 /plan：强行加 --permission-mode plan
    // （plan 模式本身不弹审批，靠 ExitPlanMode 在结束时收口，与 skip 不冲突）
    args.push('--permission-mode', 'plan')
  }
  let hookSettingsPath = null
  // ccr 不支持 --settings（会和 ccr 自己的 settings 路径冲突）；直接跳过，
  // 走 ccr 的用户仍有全局 commander-emit.sh hook 兜底，状态精度略降但不会崩。
  const cmdTpl = getConfig().cmdTemplate || ''
  const blockedByCcr = templateUsesCcr(cmdTpl)
  if (hookPort > 0 && !opts.skipHookSettings && !blockedByCcr) {
    hookSettingsPath = writeHookSettings(hookPort, sid)
    args.push('--settings', hookSettingsPath)
  }
  return { bin, args, mcpConfigPath, hookSettingsPath }
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
  if (rec.hookSettingsPath) cleanupHookSettings(rec.hookSettingsPath)
  if (rec.unsubHook) {
    try {
      rec.unsubHook()
    } catch {
      /* ignore */
    }
  }
  if (rec._clearBeat) rec._clearBeat()
  try {
    rec.child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
  // 第 5 项：通知前端会话进程死了，可以提供「重启」按钮（reason='idle' 是正常回收）
  if (reason !== 'idle') {
    const liveMs = Date.now() - (rec.spawnedAt || Date.now())
    const stderrTail = (rec.stderrBuf || '').trim().split('\n').slice(-6).join('\n')
    // 早夭（spawn 后 2s 内就死）：大概率是启动参数本身有问题（我们传的 --settings/
    // --mcp-config/hook 命令格式不对），把死因和 stderr 打到 server stdout 让人看到；
    // 同时记到 session 上，下次 ensureProc 重启时可以决定是否退避（去掉 --settings 重试）。
    if (liveMs < 2000) {
      console.error(
        `\n[converse] 子进程早夭 sid=${sid} reason=${reason} liveMs=${liveMs}\n` +
          `  cmd: ${(rec.lastArgv || []).join(' ')}\n` +
          `  stderr:\n${stderrTail.split('\n').map((l) => '    ' + l).join('\n') || '    (empty)'}\n`
      )
    }
    // 标记会话上：本次进程早夭过，restartSession 可据此选退避路径
    try {
      const sessStore = getSessions()
      const s = sessStore.sessions.find(
        (x) => x.claudeSessionId === sid || (x.aliases || []).includes(sid)
      )
      if (s) {
        s.lastDeath = { reason, liveMs, stderrTail, at: Date.now() }
        if (liveMs < 2000) {
          s.earlyDeathCount = (s.earlyDeathCount || 0) + 1
        }
        persist('sessions')
      }
    } catch {
      /* ignore */
    }
    broadcast({ type: 'session-died', sid, reason, liveMs, stderrTail })
  }
}

// 把 process.stdin 的 O_NONBLOCK 清掉再 spawn。Node 在 libuv 模式读 stdin 时会
// 把 fd 标成非阻塞；当我们 spawn 的子进程 inherit 这个 fd 并以阻塞方式读时，会
// 拿到 EAGAIN —— macOS/Linux 上长会话后出现「双光标 / 回显错乱」就是这条路径
// （参见 happy claudeLocal.ts 注释里的 slopus/happy#301）。Commander 走 webBus
// 不直通 stdin，但 ccr/claude 子进程依然 inherit 父进程 stdin，会被同一问题坑。
function clearStdinNonBlock() {
  const h = process.stdin && process.stdin._handle
  if (h && typeof h.setBlocking === 'function') {
    try {
      h.setBlocking(true)
    } catch {
      /* ignore */
    }
  }
}

// 确保会话有一个活的长驻进程；没有则 spawn。返回进程记录。
// 注意：spawn 时的 sid 可能是「老 sid」——claude 启动后会通过 stream-json /
// hook 报回真正在用的 sid（compact/fork 后会变）。我们用 currentSid 跟踪「现在
// 这个进程的当家 sid」，所有 broadcast/persist/findSession 都按当家 sid 走。
function ensureProc(initialSid, cwd) {
  const existing = procs.get(initialSid)
  if (existing && !existing.child.killed) return existing
  // 第一次有人 spawn 时也兜底点一次火（warmHookServer 是 idempotent；正常路径
  // 是 startServer() 已先点过）。fire-and-forget 不阻塞 spawn 本身 —— 第一个会话
  // 可能落到 hookPort=0 分支不挂 --settings，从第二个起就有了。
  if (hookPort === 0) warmHookServer()

  // 根据 session 的早夭历史决定是否禁用我们后加的 hook settings 注入：
  // ensureProc 第一次失败 → 第二次自动退避到「不挂 --settings」（仍走全局 hook 兜底）。
  const { sessions } = getSessions()
  const sessForRetry = sessions.find(
    (x) => x.claudeSessionId === initialSid || (x.aliases || []).includes(initialSid)
  )
  // 早夭退避优先顺序：第一次失败 → 去 --settings（最可疑），第二次失败 → 同时去
  // --include-partial-messages（怀疑老 ccr 不识别）。第三次还失败前端会看到 stderrTail。
  const earlyCount = sessForRetry?.earlyDeathCount || 0
  const skipHookSettings = earlyCount >= 1
  const skipPartial = earlyCount >= 2
  // 用户走过 /plan → session.permissionMode='plan'，下一次 spawn 带 --permission-mode plan
  const permissionMode = sessForRetry?.permissionMode || undefined
  const { bin, args, mcpConfigPath, hookSettingsPath } = buildArgs(initialSid, {
    skipHookSettings,
    skipPartial,
    permissionMode,
  })
  clearStdinNonBlock()
  // stdio: 多开一个 fd 3 给 launcher 上报 thinking 状态（第 4 项；未用 launcher 时该 fd 空闲）
  const child = spawn(bin, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  const rec = {
    child,
    buf: '',
    cwd,
    idleTimer: null,
    mcpConfigPath,
    hookSettingsPath,
    unsubHook: null,
    currentSid: initialSid,
    // 死因诊断：最近 4KB stderr + spawn 时间，用于早夭检测
    stderrBuf: '',
    spawnedAt: Date.now(),
    lastArgv: [bin, ...args],
    skippedHookSettings: skipHookSettings,
  }
  procs.set(initialSid, rec)

  // 当家 sid 变了：迁 procs key、记 alias、广播；后续 broadcast 都用新 sid。
  // 来源有两个：① stdout stream-json 里 session_id；② hook SessionStart（更准）。
  // 任一先到都触发，重复对一律幂等。
  const migrateSid = (newSid) => {
    if (!newSid || newSid === rec.currentSid) return
    const oldSid = rec.currentSid
    reassignSession(procs, oldSid, newSid)
    rec.currentSid = newSid
    broadcast({ type: 'session-migrated', oldSid, newSid })
  }

  // 订阅 hook server（按 initialSid 订阅，迁移后自然只匹配 initialSid 的 alias 路径；
  // 如果 hook 先于 stdout 到达（常见），SessionStart 会带新 sid，我们也按 '*' 兜底匹配）
  if (hookPort > 0) {
    const unsubs = []
    // SessionStart：fork/compact 时一定触发，data.session_id 是新 sid。
    // 用 '*' 通配是因为新 sid 我们事先不知道；同时按 initialSid 也订一个（兜底）。
    const handler = {
      onSessionStart: (sid /* , data */) => {
        if (!sid) return
        migrateSid(sid)
        const { sessions } = getSessions()
        const s = sessions.find(
          (x) => x.claudeSessionId === rec.currentSid || (x.aliases || []).includes(rec.currentSid)
        )
        if (s) {
          s.liveState = 'running'
          s.lastEventAt = Date.now()
          persist('sessions')
        }
      },
      onStop: () => {
        // claude 完成一轮 → waiting（已被 stream-json result 兜底，hook 是双保险）
        const sid = rec.currentSid
        const { sessions } = getSessions()
        const s = sessions.find((x) => x.claudeSessionId === sid)
        if (s) {
          s.liveState = 'waiting'
          s.lastEventAt = Date.now()
          persist('sessions')
        }
      },
      onNotification: () => {
        const sid = rec.currentSid
        const { sessions } = getSessions()
        const s = sessions.find((x) => x.claudeSessionId === sid)
        if (s) {
          s.liveState = 'waiting'
          s.lastEventAt = Date.now()
          persist('sessions')
        }
      },
    }
    unsubs.push(subscribeHook('*', handler))
    unsubs.push(subscribeHook(initialSid, handler))
    rec.unsubHook = () => unsubs.forEach((u) => u())
  }

  // 心跳法 thinking 判定（不依赖 launcher，走 ccr 也生效）：
  //   stream-json 有任意事件流入 → thinking=true；800ms 没事件 → thinking=false。
  //   launcher 走 fd3 报告 fetch-start/end 是更精确的覆盖（见下方 fd3 listener）。
  //   两路对同一个 session.thinking 标志写，后者优先（fd3 精度更高时压住心跳）。
  let beatTimer = null
  const ping = () => {
    const cs = rec.currentSid
    const { sessions } = getSessions()
    const s = sessions.find((x) => x.claudeSessionId === cs || x.sessionId === cs)
    if (!s) return
    if (!s.thinking) {
      s.thinking = true
      persist('sessions')
      broadcast({ type: 'thinking', sid: cs, thinking: true })
    }
    if (beatTimer) clearTimeout(beatTimer)
    beatTimer = setTimeout(() => {
      const cs2 = rec.currentSid
      const s2 = getSessions().sessions.find(
        (x) => x.claudeSessionId === cs2 || x.sessionId === cs2
      )
      if (s2 && s2.thinking) {
        s2.thinking = false
        persist('sessions')
        broadcast({ type: 'thinking', sid: cs2, thinking: false })
      }
    }, 800)
    if (beatTimer.unref) beatTimer.unref()
  }
  rec._clearBeat = () => {
    if (beatTimer) clearTimeout(beatTimer)
  }

  // 标记本进程有没有正在跑的 turn（用户发了消息 → true；result 或 close → false）。
  // close 到达但还在 turn 中 → 强行广播 phase:done 让前端解锁 sending。
  rec.inTurn = false

  child.stdout.on('data', (chunk) => {
    rec.buf += chunk.toString()
    let idx
    while ((idx = rec.buf.indexOf('\n')) >= 0) {
      const line = rec.buf.slice(0, idx)
      rec.buf = rec.buf.slice(idx + 1)
      if (!line.trim()) continue
      ping() // 任意事件流入即视为「还在跑」
      parseStreamLine(
        line,
        (t) => broadcast({ type: 'converse', sid: rec.currentSid, phase: 'delta', text: t }),
        (r) => {
          // 一轮 result：会话大概率又在等你
          const { sessions } = getSessions()
          const cs = rec.currentSid
          const s = sessions.find((x) => x.claudeSessionId === cs || x.sessionId === cs)
          if (s) {
            s.webBusy = false
            s.liveState = 'waiting'
            s.thinking = false
            s.lastEventAt = Date.now()
            persist('sessions')
          }
          rec.inTurn = false
          broadcast({ type: 'thinking', sid: rec.currentSid, thinking: false })
          broadcast({ type: 'converse', sid: rec.currentSid, phase: 'done', result: r.result || '', ok: r.ok })
        },
        // 第 3 项：每条 stream-json 都查 session_id；变了就迁移（fork/compact）
        migrateSid
      )
    }
  })
  child.stderr.on('data', (chunk) => {
    // 留最近 4KB 给死因诊断（ccr deprecation 噪音不算事，但子进程崩了需要这段）
    rec.stderrBuf = (rec.stderrBuf + chunk.toString()).slice(-4096)
  })

  // fd 3：launcher（第 4 项）会从这里写 fetch-start/fetch-end 行 JSON，主进程据此
  // 维护「正在思考」状态。没用 launcher 的话 fd3 是空 pipe，下面的 listener 静默无害。
  const fd3 = child.stdio[3]
  if (fd3) {
    let fbuf = ''
    let active = 0
    let stopT = null
    const setThinking = (v) => {
      const cs = rec.currentSid
      const { sessions } = getSessions()
      const s = sessions.find((x) => x.claudeSessionId === cs || x.sessionId === cs)
      if (s && s.thinking !== v) {
        s.thinking = v
        persist('sessions')
        broadcast({ type: 'thinking', sid: cs, thinking: v })
      }
    }
    fd3.on('data', (chunk) => {
      fbuf += chunk.toString()
      let i
      while ((i = fbuf.indexOf('\n')) >= 0) {
        const line = fbuf.slice(0, i).trim()
        fbuf = fbuf.slice(i + 1)
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'fetch-start') {
          active++
          if (stopT) {
            clearTimeout(stopT)
            stopT = null
          }
          setThinking(true)
        } else if (ev.type === 'fetch-end') {
          if (active > 0) active--
          if (active === 0 && !stopT) {
            stopT = setTimeout(() => {
              if (active === 0) setThinking(false)
              stopT = null
            }, 500)
          }
        }
      }
    })
    fd3.on('error', () => {})
  }

  child.on('close', () => {
    // 进程退出但还在 turn 中（没等到 result）→ 前端 sending 永远不解锁的根因。
    // 主动广播 phase:done 让 UI 解套，再走 killProc 的正常清理。
    if (rec.inTurn) {
      broadcast({
        type: 'converse',
        sid: rec.currentSid,
        phase: 'done',
        ok: false,
        error: '子进程在本轮结束前退出',
      })
      rec.inTurn = false
    }
    killProc(rec.currentSid, 'close')
  })
  child.on('error', (err) => {
    rec.inTurn = false
    broadcast({ type: 'converse', sid: rec.currentSid, phase: 'done', ok: false, error: err.message })
    killProc(rec.currentSid, 'error')
  })

  return rec
}

// 网页续话：向会话的长驻进程 stdin 喂一条 user 消息（stream-json 输入）。
// imagePaths：可选图片绝对路径，以 @path 形式拼进文本（ccr/claude 多模态读取）。
// 返回 { ok, status, error }；过程通过 ws 推 type:'converse' 增量。
export function sendMessage(claudeSessionId, text, imagePaths = []) {
  const { sessions } = getSessions()
  const session = sessions.find(
    (s) =>
      s.claudeSessionId === claudeSessionId ||
      s.sessionId === claudeSessionId ||
      (s.aliases || []).includes(claudeSessionId)
  )
  if (!session) return { ok: false, status: 404, error: '找不到该会话' }
  // 用 session 当家 sid 替换前端给的（可能是别名）—— 让后续 procs/findSession 都对得上
  claudeSessionId = session.claudeSessionId

  // Fork/compact 后的新 sid 文件可能 claude 还没写完，回退到任意一个老 alias 文件作 cwd 锚点
  let transcriptSid = claudeSessionId
  if (!findSessionFile(transcriptSid)) {
    for (const old of session.aliases || []) {
      if (findSessionFile(old)) {
        transcriptSid = old
        break
      }
    }
  }

  // 保护：别处（真终端等别的写入方）正在写同一会话、且我们并未持有它的长驻进程时，
  // 禁止注入（避免两个写入方打架）。我们自己持有的长驻进程不算「别处」——长驻下网页
  // 自己就是那个活进程，允许继续注入（这是相对旧 spec 的 running 保护重定义）。
  if (session.liveState === 'running' && !procs.has(claudeSessionId)) {
    return { ok: false, status: 409, error: '该会话可能正在终端运行，已禁止网页续话' }
  }

  const file = findSessionFile(transcriptSid)
  if (!file) return { ok: false, status: 404, error: '找不到 transcript（无法定位会话）' }

  const cwd = session.workingDir || process.cwd()

  // procs 可能也存在别名 key（如果是冷启动 + 旧 sid 进来）
  const procSid =
    procs.has(claudeSessionId)
      ? claudeSessionId
      : (session.aliases || []).find((a) => procs.has(a)) || claudeSessionId

  let rec
  try {
    rec = ensureProc(procSid, cwd)
  } catch (e) {
    return { ok: false, status: 500, error: `启动续话进程失败: ${e.message}` }
  }

  // 标记运行中（网页发起）+ 标记进程「正在 turn 中」（child.on close/error 用它判定是否要兜底发 phase:done）
  session.liveState = 'running'
  session.webBusy = true
  rec.inTurn = true
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

// A-1：ESC 中断本轮。
// 仅通过 stdin/SIGINT 控制 ccr/claude（spawn 路线无 in-band abort 通道）；策略：
//   ① SIGINT 给子进程 —— claude CLI 收到通常会立刻停止本轮 fetch/工具调用；
//   ② 同时再 stdin 注入一条 user message，告诉 AI "用户已中断"，下一轮才不迷惑；
//      这条 reason 文本是抄 happy abort RPC 用的那段（见 sessionAbort()，差异是
//      我们走 stdin 而非 SDK）。
//   ③ 把 thinking/webBusy 都清掉，broadcast turn-aborted 让前端立刻关闭"思考中"。
// 注意：SIGINT 偶尔被 claude 吞掉（取决于版本）；如果用户连按两次 abort，第二次
// 升级为 SIGTERM + killProc 触发死亡横幅，让用户手动重启。
export function abortTurn(claudeSessionId) {
  const { sessions } = getSessions()
  const session = sessions.find(
    (s) =>
      s.claudeSessionId === claudeSessionId ||
      s.sessionId === claudeSessionId ||
      (s.aliases || []).includes(claudeSessionId)
  )
  if (!session) return { ok: false, status: 404, error: '找不到该会话' }
  const sid = session.claudeSessionId
  const rec =
    procs.get(sid) ||
    procs.get((session.aliases || []).find((a) => procs.has(a)) || '')
  if (!rec) {
    // 没有长驻进程在跑 —— 没东西可中断，但也不算错。前端会自动清"思考中"。
    if (session.thinking || session.webBusy) {
      session.thinking = false
      session.webBusy = false
      session.liveState = 'waiting'
      persist('sessions')
      broadcast({ type: 'thinking', sid, thinking: false })
      broadcast({ type: 'turn-aborted', sid })
    }
    return { ok: true, status: 200, noProc: true }
  }

  const escalated = !!rec._abortedOnce
  try {
    rec.child.kill(escalated ? 'SIGTERM' : 'SIGINT')
  } catch {
    /* 已退出，无所谓 */
  }
  rec._abortedOnce = true
  // 30s 后清掉标记（足够 claude 处理完一轮，又不会无限累计）
  setTimeout(() => {
    if (rec) rec._abortedOnce = false
  }, 30 * 1000).unref?.()

  // 喂一条 reason，让 AI 知道为啥停。SIGINT 之后 stdin 可能已经关闭/不再读，try-catch 兜底。
  if (!escalated) {
    try {
      const reason = `[用户已中断本轮。如果你正在调用工具，请停止；下一条消息会告诉你接下来怎么做。]`
      rec.child.stdin?.write(JSON.stringify(buildUserMessage(reason)) + '\n')
    } catch {
      /* stdin closed, fine */
    }
  }

  session.webBusy = false
  session.thinking = false
  session.liveState = 'waiting'
  session.lastEventAt = Date.now()
  persist('sessions')
  rec.inTurn = false
  broadcast({ type: 'thinking', sid, thinking: false })
  broadcast({ type: 'turn-aborted', sid, escalated })
  return { ok: true, status: 200, escalated }
}

// 斜杠命令分发：commander 端模拟 vs 透传 vs 拒收。详见 task #11 注释。
//
// 实测在 stream-json --output-format 模式下 claude CLI 的斜杠命令绝大多数会回
// "isn't available"（TTY-only）。我们维护两份白名单：
//   PASSTHROUGH —— 实测可透传，sendMessage 即可
//   SIMULATED   —— commander 端代为实现（重 spawn / 起新 sid）
// 其余 /xxx 在前端就被挡下，根本不进这里；保险起见后端也再判一次。
export const PASSTHROUGH_SLASH = new Set([
  '/compact', '/usage', '/insights', '/code-review', '/review', '/security-review',
])
export const SIMULATED_SLASH = new Set(['/plan', '/clear'])

export function slashCommand(claudeSessionId, line, imagePaths = []) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('/')) return { ok: false, status: 400, error: '不是斜杠命令' }
  // 切分 "/cmd args..."
  const sp = raw.indexOf(' ')
  const cmd = (sp >= 0 ? raw.slice(0, sp) : raw).toLowerCase()
  const rest = sp >= 0 ? raw.slice(sp + 1).trim() : ''

  const { sessions } = getSessions()
  const session = sessions.find(
    (s) =>
      s.claudeSessionId === claudeSessionId ||
      s.sessionId === claudeSessionId ||
      (s.aliases || []).includes(claudeSessionId)
  )
  if (!session) return { ok: false, status: 404, error: '找不到该会话' }
  const sid = session.claudeSessionId

  if (PASSTHROUGH_SLASH.has(cmd)) {
    // 直接走 sendMessage（保留 args 一起发给 claude）
    return sendMessage(sid, raw, imagePaths)
  }

  if (cmd === '/plan') {
    // 标记 session 进入 plan 模式 → 杀长驻进程 → 下次 sendMessage 时 ensureProc
    // 重 spawn 带 --permission-mode plan。需要提示文字让 claude 知道用户意图。
    session.permissionMode = 'plan'
    persist('sessions')
    const rec = procs.get(sid) || procs.get((session.aliases || []).find((a) => procs.has(a)) || '')
    if (rec) killProc(rec.currentSid, 'plan-mode-switch')
    const followup = rest
      ? `[已切到 plan 模式，下面这条按 plan 模式回答]\n${rest}`
      : '[已切到 plan 模式。请用 ExitPlanMode 工具提交计划，等用户批准再执行。]'
    broadcast({ type: 'converse', sid, phase: 'delta', text: '\n[commander] 已切到 plan 模式，下一轮起生效。\n' })
    return sendMessage(sid, followup, imagePaths)
  }

  if (cmd === '/clear') {
    // 不在 claude 进程内 reset 上下文（透传 /clear 效果不明）—— 改为：杀掉长驻进程，
    // 在同 workingDir 起新 sid。会话面板上会看到新 task；老 session 保留可回溯。
    const cwd = session.workingDir || session.projectRoot
    if (!cwd) return { ok: false, status: 400, error: '当前会话没有工作目录，无法 /clear' }
    const rec = procs.get(sid) || procs.get((session.aliases || []).find((a) => procs.has(a)) || '')
    if (rec) killProc(rec.currentSid, 'clear-new-session')
    const seed = rest || '[新会话]'
    broadcast({ type: 'converse', sid, phase: 'delta', text: '\n[commander] 已清空上下文：将在同目录起一个新会话。\n' })
    const r = startSession({ workingDir: cwd, text: seed })
    return { ok: r.ok !== false, status: r.status || 200, cleared: true, newSession: r }
  }

  // 未知 / 已知 TTY-only：拒收，告诉用户去原生终端
  const TTY_ONLY = new Set([
    '/model', '/help', '/resume', '/init', '/memory', '/agents', '/mcp',
    '/diff', '/doctor', '/permissions', '/effort', '/debug', '/simplify',
    '/loop', '/context',
  ])
  if (TTY_ONLY.has(cmd)) {
    return {
      ok: false,
      status: 400,
      error: `${cmd} 只在原生终端可用，网页面板不支持。`,
    }
  }
  return {
    ok: false,
    status: 400,
    error: `未知斜杠命令 ${cmd}。网页支持：${[...PASSTHROUGH_SLASH, ...SIMULATED_SLASH].join(' ')}`,
  }
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
  const args = [
    ...baseArgs,
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages', // B-1：新建会话也开逐字流
  ]

  clearStdinNonBlock()
  const child = spawn(bin, args, { cwd, env: process.env, windowsHide: true })
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
  if (procs.has(claudeSessionId)) return true
  // 别名命中也算 busy
  const { sessions } = getSessions()
  const s = sessions.find(
    (x) => x.claudeSessionId === claudeSessionId || (x.aliases || []).includes(claudeSessionId)
  )
  if (!s) return false
  return procs.has(s.claudeSessionId) || (s.aliases || []).some((a) => procs.has(a))
}

// 会话被 dismiss/done 时回收其长驻进程（index/tasks 可调用）
export function endConverse(claudeSessionId, reason = 'ended') {
  killProc(claudeSessionId, reason)
  // 别名 key 也试一遍
  const { sessions } = getSessions()
  const s = sessions.find(
    (x) => x.claudeSessionId === claudeSessionId || (x.aliases || []).includes(claudeSessionId)
  )
  if (s) {
    for (const a of [s.claudeSessionId, ...(s.aliases || [])]) {
      if (a !== claudeSessionId && procs.has(a)) killProc(a, reason)
    }
  }
}

// 第 5 项：前端「重启会话」入口。kill 旧的（如果还在），并以当前 sid 重新 spawn。
// 返回 Promise<{ ok, status, error, stderrTail? }>。
// 关键：spawn 后等 1.2s 看进程是否早夭；早夭则把 stderr 一起返给前端（横幅显示）。
// 这样前端不会先看到"重启成功"再看到"又死了"的鬼影闪烁。
export async function restartSession(claudeSessionId) {
  const { sessions } = getSessions()
  const s = sessions.find(
    (x) => x.claudeSessionId === claudeSessionId || (x.aliases || []).includes(claudeSessionId)
  )
  if (!s) return { ok: false, status: 404, error: '找不到该会话' }
  const sid = s.claudeSessionId
  // 杀掉所有可能的 key（当家 + 别名）
  for (const a of [sid, ...(s.aliases || [])]) {
    if (procs.has(a)) killProc(a, 'restart')
  }
  let rec
  try {
    rec = ensureProc(sid, s.workingDir || process.cwd())
  } catch (e) {
    return { ok: false, status: 500, error: `重启失败: ${e.message}` }
  }
  // 等一小会儿确认子进程没立刻死。1200ms 足够 ccr/claude 报参数错。
  // 走 race 而不是 setTimeout：进程 exit 立刻 resolve，无谓等待最多到上限。
  const earlyDeath = await new Promise((resolve) => {
    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      resolve(val)
    }
    rec.child.once('exit', () => finish(true))
    rec.child.once('close', () => finish(true))
    setTimeout(() => finish(false), 1200)
  })
  if (earlyDeath || !procs.has(sid)) {
    // killProc 已经把 lastDeath 写到 session 上了
    const ld = (getSessions().sessions.find((x) => x.claudeSessionId === sid) || {}).lastDeath
    return {
      ok: false,
      status: 500,
      error: `重启后子进程立即退出（${ld?.reason || 'unknown'}）`,
      stderrTail: ld?.stderrTail || '',
      hint: rec.skippedHookSettings
        ? '已退避到无 --settings 模式仍失败，请检查 cmdTemplate 或 ccr/claude 安装'
        : '下次重启会自动退避到无 --settings 模式',
    }
  }
  s.liveState = 'waiting'
  s.lastEventAt = Date.now()
  // 重启成功 → 清零早夭计数，下次正常用 hook settings
  s.earlyDeathCount = 0
  persist('sessions')
  broadcast({ type: 'session-restarted', sid })
  return { ok: true, status: 200 }
}
