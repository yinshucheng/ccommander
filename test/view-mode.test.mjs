import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planView, toolSummary, DEFAULT_MODE } from '../src/client/view-mode.js'

// 一段典型会话：用户问 → AI 思考 + 3 个工具 + 收尾文本 → 中间夹一条纯工具返回消息。
const msgs = [
  { seq: 0, role: 'user', parts: [{ kind: 'text', text: '帮我修个 bug' }] },
  {
    seq: 1,
    role: 'assistant',
    parts: [
      { kind: 'thinking', text: '先读文件定位' },
      { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b/App.jsx' } },
      { kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm test', description: '跑测试' } },
      { kind: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/a/b/x.js' }, result: { isError: true } },
      { kind: 'text', text: '改好了，测试通过' },
      { kind: 'todos', items: [{ content: '修复', status: 'completed' }] },
    ],
  },
  // 纯工具返回消息（role tool，无 text）
  { seq: 2, role: 'tool', parts: [{ kind: 'tool_use', id: 't4', name: 'Grep', input: { pattern: 'foo' } }] },
]

const totalParts = msgs.reduce((n, m) => n + m.parts.length, 0)

test('默认档是 digest', () => {
  assert.equal(DEFAULT_MODE, 'digest')
})

test('full：每条原样，全部 show', () => {
  const plan = planView(msgs, 'full')
  assert.equal(plan.length, msgs.length)
  assert.ok(plan.every((p) => p.type === 'msg' && p.partModes.every((m) => m === 'show')))
})

test('digest：thinking/tool 折叠，text/todos 显示', () => {
  const plan = planView(msgs, 'digest')
  const ai = plan[1]
  // parts: thinking, Read, Bash, Edit, text, todos
  assert.deepEqual(ai.partModes, ['collapse', 'collapse', 'collapse', 'collapse', 'show', 'show'])
})

test('talk 核心不变量：展开占位组后 part 总数不丢', () => {
  const plan = planView(msgs, 'talk')
  // talk 节点契约：msg 节点的可见 part 在 item.parts；隐藏 part 全进 tool-group。
  const set = new Set()
  for (const item of plan) {
    const list = item.type === 'tool-group' ? item.parts : item.parts
    list.forEach((p) => set.add(p))
  }
  for (const m of msgs) for (const p of m.parts) assert.ok(set.has(p), `part 丢失: ${p.kind}`)
  assert.equal(set.size, totalParts)
})

test('talk：text/todos 显示，thinking+工具进占位组且标记 error', () => {
  const plan = planView(msgs, 'talk')
  // 第一条 user 文本是 msg
  assert.equal(plan[0].type, 'msg')
  // 存在含 error 的 tool-group
  const groups = plan.filter((p) => p.type === 'tool-group')
  assert.ok(groups.length >= 1)
  assert.ok(groups.some((g) => g.hasError), 'Edit 出错应让占位组 hasError')
  // assistant 的 text/todos 仍作为可见 msg 出现
  const aiMsg = plan.find((p) => p.type === 'msg' && p.role === 'assistant')
  assert.ok(aiMsg)
  assert.ok(aiMsg.parts.length > 0) // text/todos
})

// 把 plan 摊平成「线性渲染序列」：可见 part 用其 text/kind 占位，占位组用 [TOOL:n]。
// 顺序必须与皇帝实际看到的顺序一致——这是 Set 去重统计测不出的维度。
function renderOrder(plan) {
  const seq = []
  for (const it of plan) {
    if (it.type === 'tool-group') seq.push(`[TOOL:${it.parts.length}]`)
    else {
      const parts = it.parts || it.msg.parts
      parts.forEach((p, i) => {
        const mode = it.partModes ? it.partModes[i] : 'show'
        if (mode !== 'hide') seq.push(p.text || p.kind)
      })
    }
  }
  return seq
}

test('talk BUG-1：消息内 text→tool→text 交错，工具必须插在两段文本之间', () => {
  const m = [
    { role: 'assistant', parts: [
      { kind: 'text', text: 'A' },
      { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      { kind: 'text', text: 'B' },
    ] },
  ]
  assert.deepEqual(renderOrder(planView(m, 'talk')), ['A', '[TOOL:1]', 'B'])
})

test('talk BUG-2：跨消息的连续过程（工具+thinking）合并成一条占位组', () => {
  const m = [
    { role: 'assistant', parts: [{ kind: 'text', text: '开工' }, { kind: 'thinking', text: '嗯' }] },
    { role: 'assistant', parts: [{ kind: 'thinking', text: '再想想' }] },
    { role: 'tool', parts: [{ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] },
  ]
  const plan = planView(m, 'talk')
  const groups = plan.filter((p) => p.type === 'tool-group')
  assert.equal(groups.length, 1, '三段连续过程应合并为一条占位组')
  assert.equal(groups[0].parts.length, 3, '嗯 + 再想想 + Read 都在同一组')
  assert.deepEqual(renderOrder(plan), ['开工', '[TOOL:3]'])
})

test('talk 不变量：每个 part 恰好渲染一次（带重数，防丢失也防重复）', () => {
  const plan = planView(msgs, 'talk')
  const counts = new Map()
  for (const it of plan) {
    const list = it.type === 'tool-group' ? it.parts : (it.parts || it.msg.parts.filter((_, i) => (it.partModes?.[i] ?? 'show') !== 'hide'))
    for (const p of list) counts.set(p, (counts.get(p) || 0) + 1)
  }
  for (const mm of msgs) for (const p of mm.parts) {
    assert.equal(counts.get(p), 1, `part 应恰好出现一次: ${p.kind} ${p.text || p.name || ''}`)
  }
})

// 回归：talk 档的可见运行段节点曾漏 `msg` 字段，TaskCard 渲染时 `item.msg.seq`
// 取 undefined.seq 抛 TypeError，整个面板白屏崩溃。节点契约必须与 digest/full 统一：
// 每个 type:'msg' 节点都带 msg，渲染层据此取稳定 key / 兜底 role+text。
test('talk 渲染契约：每个 msg 节点都带 msg（防 item.msg.seq 崩溃）', () => {
  for (const mode of ['full', 'digest', 'talk']) {
    const plan = planView(msgs, mode)
    for (const item of plan) {
      if (item.type !== 'msg') continue
      assert.ok(item.msg, `${mode} 档存在缺 msg 的 msg 节点（会导致 item.msg.seq 崩溃）`)
      assert.equal(typeof item.msg.seq, 'number', `${mode} 档 msg.seq 应可取`)
    }
  }
})

test('toolSummary：动词 + 关键入参（base 取文件名）', () => {
  assert.equal(toolSummary({ name: 'Read', input: { file_path: '/a/b/App.jsx' } }), '📄 读取 App.jsx')
  assert.equal(toolSummary({ name: 'Bash', input: { command: 'pnpm test' } }), '❯ Bash pnpm test')
  assert.equal(toolSummary({ name: 'Edit', input: { file_path: '/x/y/transcript.js' } }), '✏️ 编辑 transcript.js')
})
