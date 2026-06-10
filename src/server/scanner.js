import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { upsertFromAgent } from './tasks.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// 静默阈值（秒）：文件多久没动算停下来了
const IDLE_THRESHOLD_SEC = 180

// JSONL 里非「有意义」的事件类型（判断停在谁那时跳过）
const NOISE_TYPES = new Set([
  'file-history-snapshot',
  'attachment',
  'system',
  'mode',
  'permission-mode',
  'last-prompt',
  'queue-operation',
])

// 读文件末尾若干字节，取最后 N 行（避免整文件读，会话 JSONL 可能很大）
function readTailLines(path, maxBytes = 16384) {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const fd = openSync(path, 'r')
    try {
      const len = size - start
      const buf = Buffer.allocUnsafe(len)
      const n = readSync(fd, buf, 0, len, start)
      return buf.toString('utf8', 0, n).split('\n').filter(Boolean)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

// §3.1 末状态判定：静默 + 末条非噪音事件是 assistant → waiting，否则 idle
function classify(jsonlPath, now) {
  let mtimeMs
  try {
    mtimeMs = statSync(jsonlPath).mtimeMs
  } catch {
    return null
  }
  const idleSec = (now - mtimeMs) / 1000
  if (idleSec < IDLE_THRESHOLD_SEC) return { liveState: 'running', idleSec }

  const lines = readTailLines(jsonlPath)
  let role = null
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev
    try {
      ev = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (NOISE_TYPES.has(ev.type)) continue
    role = ev.message?.role || ev.type
    break
  }
  if (role === 'assistant') return { liveState: 'waiting', idleSec }
  return { liveState: 'idle', idleSec }
}

// 扫一遍所有项目的 sessions-index.json，把会话喂给 ingest（source: scan）
export function scanOnce({ maxAgeHours = 24 } = {}) {
  if (!existsSync(PROJECTS_DIR)) return 0
  const now = Date.now()
  const cutoff = now - maxAgeHours * 3600 * 1000
  let count = 0

  let projectDirs
  try {
    projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(PROJECTS_DIR, d.name))
  } catch {
    return 0
  }

  for (const dir of projectDirs) {
    // sessions-index.json 是陈旧缓存（不含近期会话），仅用来补 summary。
    // 真实事实来源是目录下的 *.jsonl 文件——以它们为主扫描。
    const indexBySid = {}
    const indexPath = join(dir, 'sessions-index.json')
    if (existsSync(indexPath)) {
      try {
        const idx = JSON.parse(readFileSync(indexPath, 'utf8'))
        for (const e of idx.entries || []) indexBySid[e.sessionId] = e
      } catch {
        /* ignore */
      }
    }

    let files
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const jsonl = join(dir, file)
      let jsonlMtime = 0
      try {
        jsonlMtime = statSync(jsonl).mtimeMs
      } catch {
        continue
      }
      if (jsonlMtime < cutoff) continue // 只关心近期活跃的会话

      const sessionId = file.replace(/\.jsonl$/, '')
      const meta = readMeta(jsonl) // 从 JSONL 直接读 cwd/gitBranch/首条消息
      const entry = indexBySid[sessionId] || {}
      const cls = classify(jsonl, now)
      if (!cls) continue

      const projectRoot = entry.projectPath || meta.cwd || null
      upsertFromAgent({
        claudeSessionId: sessionId,
        projectName: projectRoot ? projectRoot.split('/').pop() : null,
        projectRoot,
        gitBranch: entry.gitBranch || meta.gitBranch || null,
        summary: ((entry.summary || meta.firstMsg || '') + '').slice(0, 80) || null,
        liveState: cls.liveState,
        source: 'scan',
        eventAt: jsonlMtime,
      })
      count++
    }
  }
  return count
}

// 从 JSONL 头部读 cwd / gitBranch，以及第一条 user 消息作为 summary 兜底
function readMeta(path) {
  const out = { cwd: null, gitBranch: null, firstMsg: null }
  let lines
  try {
    // 只读头部 64KB（足够拿 cwd/gitBranch 与首条 user 消息），避免整文件读
    const fd = openSync(path, 'r')
    try {
      const len = Math.min(65536, statSync(path).size)
      const buf = Buffer.allocUnsafe(len)
      const n = readSync(fd, buf, 0, len, 0)
      lines = buf.toString('utf8', 0, n).split('\n').slice(0, 60).filter(Boolean)
    } finally {
      closeSync(fd)
    }
  } catch {
    return out
  }
  for (const l of lines) {
    let ev
    try {
      ev = JSON.parse(l)
    } catch {
      continue
    }
    if (!out.cwd && ev.cwd) out.cwd = ev.cwd
    if (!out.gitBranch && ev.gitBranch) out.gitBranch = ev.gitBranch
    if (!out.firstMsg && ev.type === 'user') {
      let c = ev.message?.content
      if (Array.isArray(c)) c = c.map((x) => x.text || '').join('')
      if (typeof c === 'string') {
        const cleaned = cleanUserText(c)
        if (cleaned) out.firstMsg = cleaned // 找到第一条「真正的用户意图」即停
      }
    }
    if (out.cwd && out.gitBranch && out.firstMsg) break
  }
  return out
}

// 注入/系统前缀：这些不是用户真实意图，跳过
const NOISE_PREFIXES = [
  '<', // <command-message> / <local-command-caveat> / <command-name> 等
  'Base directory for this skill',
  'Caveat:',
  '[Request interrupted',
  'This session is being continued',
]

// 把一段 user content 清洗成「真实意图」，若整体是注入/空则返回 null
function cleanUserText(raw) {
  let t = (raw || '').trim()
  if (!t) return null
  // 去掉成对的 <command-*>…</command-*> / <local-command-*>…</…> 包裹标签
  t = t.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/<[^>]+>/g, ' ').trim()
  t = t.replace(/\s+/g, ' ')
  if (!t) return null
  for (const p of NOISE_PREFIXES) {
    if (t.startsWith(p)) return null
  }
  return t.slice(0, 120)
}

// 当前在跑的 claude 进程数（粗粒度，用于状态栏；不绑定具体会话）
export function countClaudeProcesses() {
  try {
    const out = execSync('ps -axo command', { encoding: 'utf8', timeout: 3000 })
    return out
      .split('\n')
      .filter((l) => /(^|\/)claude( |$)/.test(l) && !/grep/.test(l))
      .length
  } catch {
    return 0
  }
}

export function startScanner({ intervalMs = 30000 } = {}) {
  scanOnce()
  const timer = setInterval(() => scanOnce(), intervalMs)
  return () => clearInterval(timer)
}
