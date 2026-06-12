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

// 事件名 → hook 规格。每个 spec 产出一个或多个 hook group。
// Notification 是个「大伞」事件,含多种子类型(idle_prompt/permission_prompt/
// auth_success/elicitation_*),必须用 matcher 精筛——否则会把「权限询问」
// (permission_prompt:模型其实还在 mid-turn、卡在审批)误吞成 waiting。
// 只有 idle_prompt(真·空闲等输入)和 permission_prompt(等你点允许,也是等你)
// 才算 waiting;其余 Notification 子类型不接。详见官方 hooks 文档的 matcher 表。
const WAITING_MATCHERS = ['idle_prompt', 'permission_prompt']

const HOOK_EVENTS = {
  Notification: { type: 'waiting', matchers: WAITING_MATCHERS },
  Stop: { type: 'completed' },
  SessionStart: { type: 'running' },
  UserPromptSubmit: { type: 'running' },
  SessionEnd: { type: 'closed' },
}

// 用一个稳定标记识别「这条是 Commander 装的」，便于幂等与卸载
const TAG = 'commander-emit.sh'

function emitCommand(eventType) {
  return `bash ${EMIT_DEST} ${eventType}`
}

// 由 spec 产出待注册的 hook group 列表(纯函数,便于测试)。
// 有 matchers 的 → 每个 matcher 一条独立 group;无 matchers 的 → 一条无 matcher group。
export function buildHookGroups(spec) {
  const cmd = emitCommand(spec.type)
  const mk = (matcher) => {
    const g = { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }
    if (matcher) g.matcher = matcher
    return g
  }
  if (spec.matchers && spec.matchers.length) return spec.matchers.map(mk)
  return [mk(null)]
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

// group 是否是「我们装的」(命令含 TAG)
function isOurGroup(group) {
  return (group.hooks || []).some(
    (h) => typeof h.command === 'string' && h.command.includes(TAG),
  )
}

// 在某个事件的 hooks 数组里，确保存在按 spec 注册的 hook group（追加，不覆盖别人的）。
// 幂等:先抹掉本事件里所有「我们装的旧 group」(可能是无 matcher 的历史遗留,或
// matcher 集合变了),再按当前 spec 重新追加正确的 group。别人的 hook 原样保留。
export function ensureHook(settings, eventName, spec) {
  settings.hooks = settings.hooks || {}
  const arr = (settings.hooks[eventName] = settings.hooks[eventName] || [])
  const had = arr.some(isOurGroup)
  // 移除我们自己的旧条目(含无 matcher 的全吞遗留),保留他人 hook
  const kept = arr.filter((g) => !isOurGroup(g))
  kept.push(...buildHookGroups(spec))
  settings.hooks[eventName] = kept
  return !had // 是否首次新增(用于报告)
}

export function installHooks() {
  if (!existsSync(REPO_EMIT)) throw new Error(`缺少 emit 脚本: ${REPO_EMIT}`)
  deployEmitScript()
  const bak = backup()
  const settings = loadSettings()
  const added = []
  for (const [ev, spec] of Object.entries(HOOK_EVENTS)) {
    if (ensureHook(settings, ev, spec)) added.push(ev)
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
