import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getConfig } from './config.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// 注入/系统前缀（与 scanner 一致）：这些不是用户真实意图
const NOISE_PREFIXES = [
  'Base directory for this skill',
  'Caveat:',
  '[Request interrupted',
  'This session is being continued',
]

// 定位某个 claudeSessionId 对应的 JSONL 全路径
export function findSessionFile(claudeSessionId) {
  if (!existsSync(PROJECTS_DIR)) return null
  let dirs
  try {
    dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(PROJECTS_DIR, d.name))
  } catch {
    return null
  }
  const target = `${claudeSessionId}.jsonl`
  for (const dir of dirs) {
    const p = join(dir, target)
    if (existsSync(p)) return p
  }
  return null
}

// 清洗一段文本：去包裹标签、折叠空格、保留换行（markdown 靠换行识别结构）
function cleanText(c) {
  if (typeof c !== 'string') return ''
  return c
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

// tool_result 的 content 可能是字符串或数组块；规整成字符串
function resultToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((x) => (x.type === 'text' ? x.text || '' : typeof x === 'string' ? x : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

const RESULT_MAX = 4000 // tool_result 文本上限，超出截断
const TEXT_MAX = 6000 // 单段 text/thinking 上限

// 把一条事件的 content 拆成结构化 parts；tool_use 暂不挂 result（第二遍配对）
function buildParts(ev) {
  const c = ev.message?.content
  const parts = []
  if (typeof c === 'string') {
    const t = cleanText(c)
    if (t) parts.push({ kind: 'text', text: t })
    return parts
  }
  if (!Array.isArray(c)) return parts
  for (const x of c) {
    if (x.type === 'text') {
      const t = cleanText(x.text || '')
      if (t) parts.push({ kind: 'text', text: t.slice(0, TEXT_MAX) })
    } else if (x.type === 'thinking') {
      const t = (x.thinking || '').trim()
      if (t) parts.push({ kind: 'thinking', text: t.slice(0, TEXT_MAX) })
    } else if (x.type === 'tool_use') {
      if (x.name === 'TodoWrite') {
        const items = (x.input?.todos || []).map((td) => ({
          content: td.content || td.activeForm || '',
          status: td.status || 'pending',
        }))
        parts.push({ kind: 'todos', items })
      } else {
        parts.push({ kind: 'tool_use', id: x.id, name: x.name, input: x.input || {} })
      }
    } else if (x.type === 'tool_result') {
      const text = resultToText(x.content)
      parts.push({
        kind: 'tool_result',
        toolUseId: x.tool_use_id,
        text: text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n…（已截断）` : text,
        isError: !!x.is_error,
      })
    }
  }
  return parts
}

// 把 parts 拼成纯文本（兼容 LLM 分析 / firstMessage 等旧逻辑）
function partsToText(parts) {
  return parts
    .map((p) => {
      if (p.kind === 'text') return p.text
      if (p.kind === 'thinking') return p.text
      if (p.kind === 'tool_use') return `[${p.name}]`
      if (p.kind === 'tool_result') return '[tool_result]'
      if (p.kind === 'todos') return '[TodoWrite]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function isNoise(text) {
  if (!text) return true
  for (const p of NOISE_PREFIXES) if (text.startsWith(p)) return true
  return false
}

// 纯工具标记（[Bash] / [tool_result] / [Read] 等），没有真实文字内容
function isToolOnly(text) {
  return /^(\[[^\]]+\]\s*)+$/.test(text.trim())
}

// 提取会话上下文：第一条真实用户意图 + 一段对话（支持上翻分页）
// opts: { limit, before } —— before 是消息 seq（返回 seq < before 的最后 limit 条）
export function getSessionContext(claudeSessionId, opts = {}) {
  // 兼容旧签名 getSessionContext(sid, number)
  if (typeof opts === 'number') opts = { limit: opts }
  const file = findSessionFile(claudeSessionId)
  if (!file) return { found: false }

  const n = opts.limit || getConfig().contextRecentCount || 10
  let lines
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return { found: false }
  }

  let mtime = null
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    /* ignore */
  }

  const msgs = []
  let firstMsg = null
  let startedAt = null // 首个带 timestamp 的事件时间
  let compactGen = 0 // 已见过几次 compact 边界（compact 后的消息 gen 更高）
  let sawMeta = false // 上一条是否为 isMeta 占位（用于丢弃紧随其后的空回应）
  const resultsById = new Map() // tool_use_id → tool_result part（第二遍配对用）

  for (const l of lines) {
    let ev
    try {
      ev = JSON.parse(l)
    } catch {
      continue
    }
    // 会话启动时间：第一个带 timestamp 的事件（含 mode/system 等非对话事件）
    if (startedAt == null && ev.timestamp) startedAt = ev.timestamp
    // compact 边界：isCompactSummary 标记后的对话属于「新一代」未压缩上下文
    if (ev.isCompactSummary === true) compactGen++
    if (ev.type !== 'user' && ev.type !== 'assistant') continue
    // meta 占位：续话/恢复会话时 Claude Code 自动注入的 "Continue from where you left off."
    // （isMeta:true），不是用户真实输入，跳过；并标记下一条以丢弃模型对它的空回应
    // "No response requested."（否则会留下一条孤立的幽灵回复）。
    if (ev.isMeta === true) {
      sawMeta = true
      continue
    }
    if (sawMeta) {
      sawMeta = false
      // 紧随 meta 的 assistant 空回应（典型为 "No response requested."）一并丢弃
      if (ev.type === 'assistant' && /^No response requested\.?$/.test(partsToText(buildParts(ev)).trim())) {
        continue
      }
    }
    const parts = buildParts(ev)
    if (!parts.length) continue

    // 收集 tool_result，供配对
    for (const p of parts) {
      if (p.kind === 'tool_result' && p.toolUseId) resultsById.set(p.toolUseId, p)
    }

    // 角色：含 tool_result 且无文字的 user 事件 → 工具返回（不是用户说的）
    let role = ev.type
    if (ev.type === 'user') {
      const hasToolResult = parts.some((p) => p.kind === 'tool_result')
      const hasText = parts.some((p) => p.kind === 'text')
      if (hasToolResult && !hasText) role = 'tool'
    }

    const text = partsToText(parts)
    // 第一条真实用户意图（跳过注入前缀 + 纯工具标记 + 工具返回）
    if (!firstMsg && role === 'user' && !isNoise(text) && !isToolOnly(text)) {
      firstMsg = { role: 'user', text: text.slice(0, 300), ts: ev.timestamp || null }
    }
    msgs.push({
      seq: msgs.length,
      role,
      parts,
      text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      ts: ev.timestamp || null,
      compactGen, // 属于第几代上下文（最后一代 = 未被压缩）
    })
  }

  // 第二遍：把 tool_result 挂到对应的 tool_use part 上，并从独立消息里移除已被吸收的结果
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.kind === 'tool_use' && resultsById.has(p.id)) {
        const r = resultsById.get(p.id)
        p.result = { text: r.text, isError: r.isError }
      }
    }
    // 移除已被某个 tool_use 吸收的 tool_result（避免重复显示）
    m.parts = m.parts.filter((p) => !(p.kind === 'tool_result' && p.toolUseId))
  }
  // 吸收后变空的「工具返回」消息整条丢弃
  const filtered = msgs.filter((m) => m.parts.length > 0)
  // 重新编号 seq（保持连续，分页才正确）
  filtered.forEach((m, i) => (m.seq = i))

  // 统计：总用户轮数 + 未压缩轮数（最后一代 compactGen 里的 user 轮）
  const userTurns = filtered.filter((m) => m.role === 'user').length
  const uncompactedTurns = filtered.filter((m) => m.role === 'user' && m.compactGen === compactGen).length

  // 分页：before 给定则取 seq < before 的最后 n 条；否则取最近 n 条
  const upper = opts.before != null ? Math.max(0, Math.min(opts.before, filtered.length)) : filtered.length
  const lower = Math.max(0, upper - n)
  // compactGen 是内部统计字段，不外泄到前端消息
  const slice = filtered.slice(lower, upper).map(({ compactGen: _g, ...m }) => m)

  return {
    found: true,
    file,
    mtime,
    total: filtered.length,
    startedAt,
    userTurns,
    uncompactedTurns,
    compactCount: compactGen,
    firstMessage: firstMsg,
    recentMessages: slice,
    // 还有更早的可上翻？
    hasMore: lower > 0,
    oldestSeq: slice.length ? slice[0].seq : null,
  }
}
