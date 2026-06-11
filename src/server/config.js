import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COMMANDER_DIR = join(homedir(), '.commander')
const CONFIG_FILE = join(COMMANDER_DIR, 'config.json')

const DEFAULTS = {
  // 启动会话的命令模板。占位符：{sessionId} {workingDir}
  // 默认走原生 claude（跳过权限），透传 --resume。
  // 若你用 claude-code-router，可在 Settings 改成：
  //   ccr code --dangerously-skip-permissions --resume {sessionId}
  cmdTemplate: 'claude --dangerously-skip-permissions --resume {sessionId}',
  // 会话上下文展示「最近几条」消息
  contextRecentCount: 5,
  // 一键「稍后」默认推迟多少分钟(可在设置里改)
  deferDefaultMinutes: 30,
  // ── LLM 分析进展 ──
  // provider: 'none' = 规则粗判（默认）；'openai-compatible' = 走 OpenAI 兼容 /chat/completions
  analyzeProvider: 'none',
  analyzeBaseUrl: 'https://api.siliconflow.cn/v1',
  analyzeApiKey: '',
  analyzeModel: 'deepseek-ai/DeepSeek-V4-Flash',
}

let cache = null

function ensureDir() {
  if (!existsSync(COMMANDER_DIR)) mkdirSync(COMMANDER_DIR, { recursive: true })
}

// 老用户(011 之前)的 config.json 默认走 ccr。新默认改成原生 claude 只应作用于
// 「首次创建配置」；对「文件已存在但缺 cmdTemplate 字段」的老配置，沿用旧默认 ccr，
// 否则升级会静默把这些用户的续话从 ccr 切到 claude（行为倒退）。
const LEGACY_CMD_TEMPLATE = 'ccr code --dangerously-skip-permissions --resume {sessionId}'

export function getConfig() {
  if (cache) return cache
  ensureDir()
  if (existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      cache = { ...DEFAULTS, ...parsed }
      // 文件已存在但没写 cmdTemplate → 视为升级前的老配置，保留旧默认而非套用新默认
      if (!('cmdTemplate' in parsed)) cache.cmdTemplate = LEGACY_CMD_TEMPLATE
    } catch {
      cache = { ...DEFAULTS }
    }
  } else {
    cache = { ...DEFAULTS }
    // 首次写出默认，方便用户直接编辑文件
    writeConfig(cache)
  }
  return cache
}

function writeConfig(obj) {
  ensureDir()
  const tmp = `${CONFIG_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, CONFIG_FILE)
}

export function patchConfig(patch = {}) {
  const cur = getConfig()
  const allowed = [
    'cmdTemplate',
    'contextRecentCount',
    'deferDefaultMinutes',
    'analyzeProvider',
    'analyzeBaseUrl',
    'analyzeApiKey',
    'analyzeModel',
  ]
  for (const k of allowed) {
    if (k in patch) cur[k] = patch[k]
  }
  if (typeof cur.contextRecentCount === 'string') {
    cur.contextRecentCount = Number(cur.contextRecentCount) || DEFAULTS.contextRecentCount
  }
  if (typeof cur.deferDefaultMinutes === 'string') {
    cur.deferDefaultMinutes = Number(cur.deferDefaultMinutes) || DEFAULTS.deferDefaultMinutes
  }
  writeConfig(cur)
  cache = cur
  return cur
}

// 用模板渲染出启动命令
export function renderCommand(sessionId, workingDir = '') {
  const tpl = getConfig().cmdTemplate || DEFAULTS.cmdTemplate
  if (!sessionId) return ''
  return tpl
    .replace(/\{sessionId\}/g, sessionId)
    .replace(/\{workingDir\}/g, workingDir || '')
    .trim()
}

export { CONFIG_FILE, DEFAULTS }
