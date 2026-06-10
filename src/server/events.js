import { existsSync, mkdirSync, statSync, openSync, readSync, closeSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { upsertFromAgent } from './tasks.js'

const COMMANDER_DIR = join(homedir(), '.commander')
const EVENTS_FILE = join(COMMANDER_DIR, 'events.jsonl')

// 事件类型 → liveState
const EVENT_STATE = {
  waiting: 'waiting',
  completed: 'completed',
  running: 'running',
  started: 'running',
  closed: 'idle',
}

let offset = 0
let buffer = ''

function ensureFile() {
  if (!existsSync(COMMANDER_DIR)) mkdirSync(COMMANDER_DIR, { recursive: true })
  if (!existsSync(EVENTS_FILE)) {
    closeSync(openSync(EVENTS_FILE, 'a'))
  }
}

// 把一条事件记录喂给 ingest
function handleLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return
  let ev
  try {
    ev = JSON.parse(trimmed)
  } catch {
    return
  }
  if (!ev.sid) return
  const liveState = EVENT_STATE[ev.type] || 'running'
  upsertFromAgent({
    claudeSessionId: ev.sid,
    projectName: ev.project || null,
    projectRoot: ev.root || ev.cwd || null,
    cwd: ev.cwd || null,
    gitBranch: ev.branch || null,
    summary: ev.name || null,
    liveState,
    source: 'hook',
    eventAt: ev.ts ? Date.parse(ev.ts) || Date.now() : Date.now(),
  })
}

// 从 offset 读取新增内容，按行处理
function readNew() {
  let size
  try {
    size = statSync(EVENTS_FILE).size
  } catch {
    return
  }
  if (size < offset) {
    // 文件被截断/轮转，重置
    offset = 0
    buffer = ''
  }
  if (size === offset) return
  const fd = openSync(EVENTS_FILE, 'r')
  try {
    const len = size - offset
    const buf = Buffer.allocUnsafe(len)
    const bytes = readSync(fd, buf, 0, len, offset)
    offset += bytes
    buffer += buf.toString('utf8', 0, bytes)
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      handleLine(line)
    }
  } finally {
    closeSync(fd)
  }
}

export function startEvents({ replayHistory = false } = {}) {
  ensureFile()
  if (!replayHistory) {
    // 默认只消费启动之后的新事件（历史会话交给 scanner 兜底）
    try {
      offset = statSync(EVENTS_FILE).size
    } catch {
      offset = 0
    }
  }
  // watch + 轮询双保险（fs.watch 在某些场景丢事件）
  try {
    watch(EVENTS_FILE, { persistent: false }, () => readNew())
  } catch {
    /* fall back to polling only */
  }
  const timer = setInterval(readNew, 2000)
  readNew()
  return () => clearInterval(timer)
}

export { EVENTS_FILE, COMMANDER_DIR }
