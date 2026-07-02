// converse.js 回归测试 —— 钉住「网页续话支持粘贴图片」的核心不变量。
// 跑: pnpm test  (= node --test test/)
//
// saveUploads 把前端 base64 data URL 落成临时文件，路径以 @path 注入 prompt。
// 不变量：① 正确解码并写盘；② 文件名无空格（否则 @path 在 prompt 里按空格被切断）；
//         ③ 扩展名按 MIME 推断；④ 非法 data URL 被跳过而非抛错/产生坏文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, unlink } from 'node:fs/promises'
import { saveUploads, extractSessionId, parseStreamLine } from '../src/server/converse.js'

// 1x1 像素 PNG（合法 base64），用作最小图片载荷
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('saveUploads 解码 base64 并写盘，路径无空格', async () => {
  const paths = await saveUploads([{ name: 'shot.png', dataUrl: `data:image/png;base64,${PNG_1PX}` }])
  try {
    assert.equal(paths.length, 1)
    const p = paths[0]
    assert.ok(!/\s/.test(p), `路径不应含空格: ${p}`) // 否则 @path 会被 prompt 的空格切断
    assert.match(p, /\.png$/)
    const buf = await readFile(p)
    assert.ok(buf.length > 0, '文件应有内容')
  } finally {
    for (const p of paths) await unlink(p).catch(() => {})
  }
})

test('saveUploads 按 MIME 推断扩展名', async () => {
  const paths = await saveUploads([
    { dataUrl: `data:image/jpeg;base64,${PNG_1PX}` },
    { dataUrl: `data:image/webp;base64,${PNG_1PX}` },
  ])
  try {
    assert.match(paths[0], /\.jpg$/)
    assert.match(paths[1], /\.webp$/)
  } finally {
    for (const p of paths) await unlink(p).catch(() => {})
  }
})

test('saveUploads 跳过非法 data URL，不抛错', async () => {
  const paths = await saveUploads([{ dataUrl: 'not-a-data-url' }, { dataUrl: '' }, {}])
  assert.deepEqual(paths, [])
})

test('saveUploads 空入参返回空数组', async () => {
  assert.deepEqual(await saveUploads([]), [])
  assert.deepEqual(await saveUploads(), [])
})

// ── 新建会话：从 stream-json 抽 session_id（spec 013）──
// 不变量：新建会话靠从 init/system 事件抓 session_id 来 upsertFromAgent 入队。
// 抓不到只能等 scanner 30s 兜底，秒级反馈全靠这里——钉死它。

test('extractSessionId 从 system/init 事件抽 session_id', () => {
  assert.equal(
    extractSessionId({ type: 'system', subtype: 'init', session_id: 'abc-123', cwd: '/x' }),
    'abc-123'
  )
})

test('extractSessionId 兜底认 camelCase sessionId', () => {
  assert.equal(extractSessionId({ type: 'system', sessionId: 'def-456' }), 'def-456')
})

test('extractSessionId 对不带 id 的增量/空输入返回 null', () => {
  assert.equal(extractSessionId({ type: 'assistant', message: { content: [] } }), null)
  assert.equal(extractSessionId({ type: 'result', result: 'done' }), null)
  assert.equal(extractSessionId(null), null)
  assert.equal(extractSessionId('garbage'), null)
})

// templateUsesCcr：决定是否注入 --settings（ccr 会和它自己的 settings 路径冲突）
import { templateUsesCcr } from '../src/server/converse.js'

test('templateUsesCcr: ccr 开头 → true', () => {
  assert.equal(templateUsesCcr('ccr code --dangerously-skip-permissions --resume {sessionId}'), true)
  assert.equal(templateUsesCcr('ccr'), true)
})

test('templateUsesCcr: 非 ccr → false', () => {
  assert.equal(templateUsesCcr('claude --dangerously-skip-permissions --resume {sessionId}'), false)
  assert.equal(templateUsesCcr('node /path/launcher.cjs /path/claude'), false)
  assert.equal(templateUsesCcr(''), false)
  assert.equal(templateUsesCcr('  '), false)
})

// ── spec 016：parseStreamLine 必须把 thinking / tool_use / tool_result 全推出来 ──
// 不变量：网页实时流不能再丢这三类事件（终端能看到、网页看不到 = 退化）。
// 测的是「事件 → 回调」的纯函数行为，不起进程。

function collect() {
  const out = { text: [], thinking: [], toolUse: [], toolResult: [], result: null, session: null }
  return {
    out,
    cbs: {
      onText: (t) => out.text.push(t),
      onResult: (r) => (out.result = r),
      onSession: (s) => (out.session = s),
      onThinking: (t, id) => out.thinking.push({ t, id }),
      onToolUse: (u) => out.toolUse.push(u),
      onToolResult: (r) => out.toolResult.push(r),
    },
  }
}

test('parseStreamLine: partial 模式 thinking_delta → onThinking', () => {
  const { out, cbs } = collect()
  const ev = JSON.stringify({
    type: 'stream_event',
    session_id: 'sid-1',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '让我想想…' },
    },
  })
  parseStreamLine(ev, cbs.onText, cbs.onResult, cbs.onSession, {
    onThinking: cbs.onThinking,
    onToolUse: cbs.onToolUse,
    onToolResult: cbs.onToolResult,
  })
  assert.deepEqual(out.thinking, [{ t: '让我想想…', id: 0 }])
  assert.equal(out.text.length, 0)
})

test('parseStreamLine: 非 partial assistant 含 thinking part → onThinking 整段', () => {
  const { out, cbs } = collect()
  const ev = JSON.stringify({
    type: 'assistant',
    session_id: 'sid-2', // 没见过 stream_event，sawPartial=false，整段不跳
    message: {
      content: [
        { type: 'thinking', thinking: '整段思考' },
        { type: 'text', text: '答案是 42' },
      ],
    },
  })
  parseStreamLine(ev, cbs.onText, cbs.onResult, cbs.onSession, {
    onThinking: cbs.onThinking,
    onToolUse: cbs.onToolUse,
    onToolResult: cbs.onToolResult,
  })
  assert.equal(out.thinking.length, 1)
  assert.equal(out.thinking[0].t, '整段思考')
  assert.deepEqual(out.text, ['答案是 42'])
})

test('parseStreamLine: assistant 含 tool_use → onToolUse 拆出 id/name/input', () => {
  const { out, cbs } = collect()
  const ev = JSON.stringify({
    type: 'assistant',
    session_id: 'sid-3',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/x.js' } },
      ],
    },
  })
  parseStreamLine(ev, cbs.onText, cbs.onResult, cbs.onSession, {
    onThinking: cbs.onThinking,
    onToolUse: cbs.onToolUse,
    onToolResult: cbs.onToolResult,
  })
  assert.deepEqual(out.toolUse, [{ id: 'toolu_01', name: 'Read', input: { file_path: '/x.js' } }])
  // 旧版会推 '[调用工具: Read]' 到 onText，新版只走 onToolUse
  assert.equal(out.text.length, 0)
})

test('parseStreamLine: user 含 tool_result → onToolResult 透传 content + is_error', () => {
  const { out, cbs } = collect()
  const ev = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: '文件第 1 行…', is_error: false },
      ],
    },
  })
  parseStreamLine(ev, cbs.onText, cbs.onResult, cbs.onSession, {
    onThinking: cbs.onThinking,
    onToolUse: cbs.onToolUse,
    onToolResult: cbs.onToolResult,
  })
  assert.deepEqual(out.toolResult, [
    { tool_use_id: 'toolu_01', content: '文件第 1 行…', is_error: false },
  ])
})

test('parseStreamLine: tool_result.is_error=true 被透传（前端可标红）', () => {
  const { out, cbs } = collect()
  const ev = JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'permission denied', is_error: true }],
    },
  })
  parseStreamLine(ev, cbs.onText, cbs.onResult, cbs.onSession, {
    onThinking: cbs.onThinking,
    onToolUse: cbs.onToolUse,
    onToolResult: cbs.onToolResult,
  })
  assert.equal(out.toolResult.length, 1)
  assert.equal(out.toolResult[0].is_error, true)
})

test('parseStreamLine: tool_result.content 是 array 时原样透传（前端兼容多 part）', () => {
  const { out, cbs } = collect()
  const arr = [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', data: '...' } }]
  const ev = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_03', content: arr }] },
  })
  parseStreamLine(ev, cbs.onText, cbs.onResult, cbs.onSession, {
    onThinking: cbs.onThinking,
    onToolUse: cbs.onToolUse,
    onToolResult: cbs.onToolResult,
  })
  // JSON.parse 反序列化后是新对象（引用不等），断言结构同构即可
  assert.deepEqual(out.toolResult[0].content, arr)
  assert.ok(Array.isArray(out.toolResult[0].content)) // 前端按 Array.isArray 分发
})

test('parseStreamLine: 老调用方不传 cbs 也不抛错（向后兼容）', () => {
  const { out, cbs } = collect()
  // 故意只传 4 个参数（旧签名），事件含 thinking——应静默丢弃，不抛
  parseStreamLine(
    JSON.stringify({
      type: 'assistant',
      session_id: 'sid-x',
      message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'ok' }] },
    }),
    cbs.onText,
    cbs.onResult,
    cbs.onSession
  )
  assert.deepEqual(out.text, ['ok'])
  assert.equal(out.thinking.length, 0) // 没传 onThinking，被默认 no-op 吃掉
})

