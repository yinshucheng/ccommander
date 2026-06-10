import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COMMANDER_DIR = join(homedir(), '.commander')
const CONFIG_FILE = join(COMMANDER_DIR, 'config.json')

const DEFAULTS = {
  // 启动会话的命令模板。占位符：{sessionId} {workingDir}
  // 默认走 ccr（claude-code-router），透传 --resume 给 claude
  cmdTemplate: 'ccr code --dangerously-skip-permissions --resume {sessionId}',
  // 会话上下文展示「最近几条」消息
  contextRecentCount: 5,
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

export function getConfig() {
  if (cache) return cache
  ensureDir()
  if (existsSync(CONFIG_FILE)) {
    try {
      cache = { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
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
