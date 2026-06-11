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

// 找一个消息条数明显多于一页的会话,用来验证 before 分页（自动上滑加载依赖它）。
function findPaginatableSession() {
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
        c = getSessionContext(sid, { limit: 10 })
      } catch {
        continue
      }
      if (c.found && c.hasMore && c.recentMessages.length >= 2) return sid
    }
  }
  return null
}

const PAGE_SID = findPaginatableSession()
const NO_PAGE = '~/.claude/projects 下没有「条数 > 一页」的会话样本,跳过'

// 找一个发生过 compact 的会话,用来验证未压缩轮次统计。
function findCompactedSession() {
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
        c = getSessionContext(sid, { limit: 5 })
      } catch {
        continue
      }
      if (c.found && c.compactCount > 0) return c
    }
  }
  return null
}

// 任意一个可解析的会话（用于通用字段断言，不要求 compact）。
function findAnySession() {
  if (!existsSync(PROJECTS_DIR)) return null
  for (const d of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, d)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      let c
      try {
        c = getSessionContext(f.slice(0, -'.jsonl'.length), { limit: 5 })
      } catch {
        continue
      }
      if (c.found && c.userTurns > 0) return c
    }
  }
  return null
}

const COMPACTED = findCompactedSession()
const ANY = findAnySession()

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

// 回归: 自动上滑加载历史 —— 根因层是 getSessionContext 的 before 分页契约。
// 前端滚到顶部用 before=msgs[0].seq 取更早一页;若分页拿不到更早消息或
// hasMore 不正确翻转,自动加载就会空转或永远转圈。
test('回归: before 分页能取到更早的消息且不与首页重叠', (t) => {
  if (!PAGE_SID) return t.skip(NO_PAGE)
  const first = getSessionContext(PAGE_SID, { limit: 10 })
  assert.ok(first.found && first.hasMore, '样本应有更多历史')
  assert.ok(first.recentMessages.length > 0, '首页不应为空')

  const oldestSeq = first.recentMessages[0].seq
  const older = getSessionContext(PAGE_SID, { limit: 10, before: oldestSeq })
  assert.ok(older.found, 'before 分页应能取到内容')
  assert.ok(older.recentMessages.length > 0, 'before 分页返回了空 —— 自动加载会空转')

  // 返回的都必须严格早于 before 锚点（seq < before）,否则上翻会出现重复消息。
  for (const m of older.recentMessages) {
    assert.ok(m.seq < oldestSeq, `分页返回了 seq=${m.seq} >= before=${oldestSeq},会与首页重叠`)
  }
})

test('回归: 取到最早一页后 hasMore 翻为 false（自动加载停得下来）', (t) => {
  if (!PAGE_SID) return t.skip(NO_PAGE)
  // 一路 before 翻到底,hasMore 必须最终变 false,否则前端会无限请求。
  let before = getSessionContext(PAGE_SID, { limit: 10 }).recentMessages[0].seq
  let hasMore = true
  let guard = 0
  while (hasMore && guard++ < 500) {
    const page = getSessionContext(PAGE_SID, { limit: 10, before })
    if (!page.recentMessages.length) {
      hasMore = page.hasMore
      break
    }
    before = page.recentMessages[0].seq
    hasMore = page.hasMore
  }
  assert.ok(guard < 500, '翻页未收敛 —— hasMore 永不为 false,前端会无限上滑加载')
  assert.equal(hasMore, false, '翻到最早一页后 hasMore 应为 false')
})

// spec 008: 右栏展示会话统计 —— 启动时间 / 总轮次 / 未压缩轮次。
test('008: 会话统计字段齐备且类型正确', (t) => {
  if (!ANY) return t.skip(NO_SAMPLE)
  assert.ok(ANY.startedAt, 'startedAt 缺失 —— 右栏「启动时间」会空')
  assert.equal(typeof ANY.userTurns, 'number', 'userTurns 应为数字')
  assert.equal(typeof ANY.uncompactedTurns, 'number', 'uncompactedTurns 应为数字')
  assert.ok(ANY.userTurns > 0, 'userTurns 应 > 0（样本至少一轮用户消息）')
  // 内部统计字段 compactGen 不应泄漏到前端消息
  assert.ok(!('compactGen' in (ANY.recentMessages[0] || {})), 'compactGen 不该出现在 recentMessages 里')
})

test('008: 未压缩轮次 ≤ 总用户轮次（核心不变量）', (t) => {
  if (!ANY) return t.skip(NO_SAMPLE)
  assert.ok(
    ANY.uncompactedTurns <= ANY.userTurns,
    `uncompacted=${ANY.uncompactedTurns} 不该 > user=${ANY.userTurns}`
  )
})

test('008: 无 compact 时未压缩轮次 == 总用户轮次', (t) => {
  if (!ANY) return t.skip(NO_SAMPLE)
  if (ANY.compactCount > 0) return t.skip('该样本发生过 compact,此断言不适用')
  assert.equal(ANY.uncompactedTurns, ANY.userTurns, '无 compact 时未压缩轮次应等于总轮次')
})

test('008: 发生过 compact 的会话,未压缩轮次严格小于总轮次', (t) => {
  if (!COMPACTED) return t.skip('~/.claude/projects 下没有发生过 compact 的会话样本,跳过')
  assert.ok(COMPACTED.compactCount > 0, '样本应发生过 compact')
  assert.ok(
    COMPACTED.uncompactedTurns < COMPACTED.userTurns,
    `compact 后未压缩轮次(${COMPACTED.uncompactedTurns})应 < 总轮次(${COMPACTED.userTurns})`
  )
})
