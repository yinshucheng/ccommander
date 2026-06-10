// transcript.js 回归测试 —— 钉住修过的 bug 与核心不变量。
// 跑: pnpm test  (= node --test test/)
//
// 这里不内嵌固定 fixture（会话 jsonl 因机器而异、可能被删）,
// 而是从 ~/.claude/projects 现场挑一个满足条件的会话当样本。
// 没有合适样本时 t.skip,而不是误报失败。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionContext } from '../src/server/transcript.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// 找一个「足够丰富」的会话：含配对的工具调用 + 含换行的文本。模块加载时算一次。
function findRichSession() {
  if (!existsSync(PROJECTS_DIR)) return null
  for (const d of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, d)
    let isDir
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const sid = f.slice(0, -'.jsonl'.length)
      let c
      try {
        c = getSessionContext(sid, { limit: 40 })
      } catch {
        continue
      }
      if (!c.found) continue
      const parts = c.recentMessages.flatMap((m) => m.parts || [])
      const pairedTool = parts.some((p) => p.kind === 'tool_use' && p.result)
      const multilineText = c.recentMessages.some((m) =>
        (m.parts || []).some((p) => p.kind === 'text' && p.text.includes('\n'))
      )
      if (pairedTool && multilineText) return c
    }
  }
  return null
}

const SAMPLE = findRichSession()
const NO_SAMPLE = '~/.claude/projects 下没有满足条件的会话样本,跳过'

test('每条消息都带结构化 parts', (t) => {
  if (!SAMPLE) return t.skip(NO_SAMPLE)
  for (const m of SAMPLE.recentMessages) {
    assert.ok(Array.isArray(m.parts), '消息缺少 parts 数组')
    assert.ok(m.parts.length > 0, '消息 parts 为空（应被过滤掉）')
  }
})

test('回归: text 的换行不被折叠（markdown 结构依赖换行）', (t) => {
  if (!SAMPLE) return t.skip(NO_SAMPLE)
  const hasNewline = SAMPLE.recentMessages.some((m) =>
    (m.parts || []).some((p) => p.kind === 'text' && p.text.includes('\n'))
  )
  assert.ok(hasNewline, 'text part 的换行被折叠了 —— renderContent 又把 \\n 吃掉了')
})

test('回归: tool_use 与 tool_result 后端配对', (t) => {
  if (!SAMPLE) return t.skip(NO_SAMPLE)
  const tools = SAMPLE.recentMessages
    .flatMap((m) => m.parts || [])
    .filter((p) => p.kind === 'tool_use')
  const withResult = tools.filter((p) => p.result)
  assert.ok(withResult.length > 0, '没有任何 tool_use 配上 result —— 配对逻辑回归')
  for (const p of withResult) {
    assert.equal(typeof p.result.text, 'string', 'result.text 应为字符串')
    assert.equal(typeof p.result.isError, 'boolean', 'result.isError 应为布尔')
  }
})

test('回归: 独立 tool_result 噪音消息被吸收（不残留 kind=tool_result）', (t) => {
  if (!SAMPLE) return t.skip(NO_SAMPLE)
  const stray = SAMPLE.recentMessages
    .flatMap((m) => m.parts || [])
    .filter((p) => p.kind === 'tool_result')
  assert.equal(stray.length, 0, `还有 ${stray.length} 个未被吸收的 tool_result part`)
})

test('保留顶层 text 兼容字段（供 LLM 分析 / firstMessage）', (t) => {
  if (!SAMPLE) return t.skip(NO_SAMPLE)
  for (const m of SAMPLE.recentMessages) {
    assert.equal(typeof m.text, 'string', '消息缺少顶层 text 字段')
  }
})
