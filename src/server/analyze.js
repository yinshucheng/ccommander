import { getSessionContext } from './transcript.js'
import { getConfig } from './config.js'

// 会话「完成度」分析。
//
// provider:
//   'none'              —— 规则粗判（默认，不花钱、不联网）
//   'openai-compatible' —— 走 OpenAI 兼容 /chat/completions（SiliconFlow / Moonshot / 等）
//
// LLM 分支：把第一条意图 + 最近一段对话拼成 prompt，要求模型返回结构化判断。
export async function analyzeSession(claudeSessionId) {
  // 给 LLM 多一点上下文（最近 16 条），规则分支只用其中最后一条
  const ctx = getSessionContext(claudeSessionId, { limit: 16 })
  if (!ctx.found) {
    return { ok: false, reason: '找不到该会话的 transcript' }
  }

  const cfg = getConfig()
  const provider = cfg.analyzeProvider || 'none'

  if (provider === 'none') {
    return ruleAnalyze(ctx)
  }

  if (provider === 'openai-compatible') {
    if (!cfg.analyzeApiKey) {
      return { ok: false, reason: '未配置 analyzeApiKey（在设置或 ~/.commander/config.json 填）' }
    }
    try {
      return await llmAnalyze(ctx, cfg)
    } catch (e) {
      return { ok: false, reason: `LLM 分析失败：${e.message}` }
    }
  }

  return { ok: false, reason: `analyzeProvider="${provider}" 未知` }
}

// ── 规则兜底 ──
function ruleAnalyze(ctx) {
  const last = ctx.recentMessages[ctx.recentMessages.length - 1]
  let stage = '进行中'
  if (last) {
    if (last.role === 'assistant' && !last.text.startsWith('[')) stage = '疑似等待你输入'
    else if (last.role === 'user' && last.text === '[tool_result]') stage = '执行中（工具调用）'
  }
  return {
    ok: true,
    provider: 'rule',
    stage,
    summary: ctx.firstMessage?.text?.slice(0, 80) || '(无)',
    messageCount: ctx.total,
    note: '当前为规则粗判。接入 LLM：在设置里把「分析 Provider」设为 openai-compatible 并填 key。',
  }
}

// ── LLM 分析 ──
function buildMessages(ctx) {
  const convo = ctx.recentMessages
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.text}`)
    .join('\n')
  const system =
    '你是一个会话进展分析器。给你一个 Claude Code 编程会话的「最初意图」和「最近若干条对话」，' +
    '判断这个会话当前进行到什么阶段、是否在等用户输入、卡在哪、用户下一步该做什么。' +
    '只输出 JSON，不要任何额外文字，格式：' +
    '{"stage":"进行中|等待用户输入|疑似完成|出错卡住","summary":"一句话进展概述","blocker":"卡点或空字符串","nextStep":"建议用户做的下一步"}'
  const user = `【最初意图】\n${ctx.firstMessage?.text || '(未知)'}\n\n【最近对话，共 ${ctx.total} 条，下面是末尾 ${ctx.recentMessages.length} 条】\n${convo}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function extractJson(text) {
  // 容错：模型可能裹了 ```json 或前后有文字
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

async function llmAnalyze(ctx, cfg) {
  const url = `${cfg.analyzeBaseUrl.replace(/\/$/, '')}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.analyzeApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.analyzeModel,
        messages: buildMessages(ctx),
        max_tokens: 400,
        temperature: 0.3,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status} ${body.slice(0, 120)}`)
  }
  const data = await resp.json()
  const content = data.choices?.[0]?.message?.content || ''
  const parsed = extractJson(content)
  if (!parsed) {
    // 模型没按格式输出，至少把原文回去
    return {
      ok: true,
      provider: 'llm',
      model: cfg.analyzeModel,
      stage: '（无法解析）',
      summary: content.slice(0, 200),
      messageCount: ctx.total,
    }
  }
  return {
    ok: true,
    provider: 'llm',
    model: cfg.analyzeModel,
    stage: parsed.stage || '进行中',
    summary: parsed.summary || '',
    blocker: parsed.blocker || '',
    nextStep: parsed.nextStep || '',
    messageCount: ctx.total,
  }
}
