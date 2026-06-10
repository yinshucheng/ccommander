import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_EMIT = join(__dirname, '../../hooks/commander-emit.sh')

const HOME = homedir()
const SETTINGS = join(HOME, '.claude', 'settings.json')
const COMMANDER_BIN = join(HOME, '.commander', 'bin')
const EMIT_DEST = join(COMMANDER_BIN, 'commander-emit.sh')

// 事件名 → 传给 emit 脚本的 event_type
const HOOK_EVENTS = {
  Notification: 'waiting',
  Stop: 'completed',
  SessionStart: 'running',
  UserPromptSubmit: 'running',
  SessionEnd: 'closed',
}

// 用一个稳定标记识别「这条是 Commander 装的」，便于幂等与卸载
const TAG = 'commander-emit.sh'

function emitCommand(eventType) {
  return `bash ${EMIT_DEST} ${eventType}`
}

function deployEmitScript() {
  mkdirSync(COMMANDER_BIN, { recursive: true })
  copyFileSync(REPO_EMIT, EMIT_DEST)
  chmodSync(EMIT_DEST, 0o755)
}

function loadSettings() {
  if (!existsSync(SETTINGS)) return {}
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'))
  } catch (e) {
    throw new Error(`无法解析 ${SETTINGS}: ${e.message}`)
  }
}

function backup() {
  if (existsSync(SETTINGS)) {
    const bak = `${SETTINGS}.commander-bak`
    copyFileSync(SETTINGS, bak)
    return bak
  }
  return null
}

// 在某个事件的 hooks 数组里，确保存在一条调用我们 emit 脚本的 command（追加，不覆盖）
function ensureHook(settings, eventName, eventType) {
  settings.hooks = settings.hooks || {}
  const arr = (settings.hooks[eventName] = settings.hooks[eventName] || [])
  // 已存在则更新命令，避免重复
  for (const group of arr) {
    for (const h of group.hooks || []) {
      if (typeof h.command === 'string' && h.command.includes(TAG)) {
        h.command = emitCommand(eventType)
        return false // 已存在
      }
    }
  }
  // 追加一个新的 hook group（与现有 notify-*/vibe-island 并存）
  arr.push({ hooks: [{ type: 'command', command: emitCommand(eventType), timeout: 5 }] })
  return true // 新增
}

export function installHooks() {
  if (!existsSync(REPO_EMIT)) throw new Error(`缺少 emit 脚本: ${REPO_EMIT}`)
  deployEmitScript()
  const bak = backup()
  const settings = loadSettings()
  const added = []
  for (const [ev, type] of Object.entries(HOOK_EVENTS)) {
    if (ensureHook(settings, ev, type)) added.push(ev)
  }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2))
  return { backup: bak, added, settingsPath: SETTINGS, emitScript: EMIT_DEST }
}

// 移除 Commander 追加的 hook（精确匹配 TAG，不动别人的）
export function uninstallHooks() {
  const bak = backup()
  const settings = loadSettings()
  let removed = 0
  for (const ev of Object.keys(settings.hooks || {})) {
    const arr = settings.hooks[ev]
    const kept = []
    for (const group of arr) {
      const hooks = (group.hooks || []).filter((h) => {
        const isOurs = typeof h.command === 'string' && h.command.includes(TAG)
        if (isOurs) removed++
        return !isOurs
      })
      if (hooks.length > 0) kept.push({ ...group, hooks })
    }
    if (kept.length > 0) settings.hooks[ev] = kept
    else delete settings.hooks[ev]
  }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2))
  return { backup: bak, removed }
}
