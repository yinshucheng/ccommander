// 批阅视图档位（spec 012）：纯展示层过滤，不删数据。
// 抽成无 React 依赖的纯函数，便于 node --test 断言「隐藏≠删除」这条核心不变量。

export const VIEW_MODES = ['full', 'digest', 'talk']
export const DEFAULT_MODE = 'digest'
export const VIEW_MODE_LABEL = { full: '全文', digest: '摘要', talk: '对话' }

// 工具 → 单行摘要的图标 + 中文动词 + 关键入参字段。
// 与 parts.jsx 的渲染元数据语义一致；这里独立维护一份「摘要用」的精简表，
// 避免把 React 组件文件拖进纯函数测试。新增工具时两处都补即可。
const TOOL_SUMMARY_META = {
  Edit: { icon: '✏️', verb: '编辑', key: 'file_path', base: true },
  Write: { icon: '📝', verb: '写入', key: 'file_path', base: true },
  Read: { icon: '📄', verb: '读取', key: 'file_path', base: true },
  Bash: { icon: '❯', verb: 'Bash', key: 'command' },
  Grep: { icon: '🔍', verb: '搜索', key: 'pattern' },
  Glob: { icon: '🗂️', verb: '匹配', key: 'pattern' },
  LS: { icon: '📁', verb: '列目录', key: 'path', base: true },
}

function basename(p = '') {
  return String(p).split('/').filter(Boolean).pop() || String(p)
}

// 单条 tool_use part → 一行摘要文本（图标 + 动词 + 关键入参，截断防溢出）
export function toolSummary(part) {
  const meta = TOOL_SUMMARY_META[part.name]
  if (!meta) {
    // 兜底：未知工具只给名字
    return `🔧 ${part.name}`
  }
  let arg = part.input?.[meta.key] ?? ''
  arg = meta.base ? basename(arg) : String(arg)
  arg = arg.replace(/\s+/g, ' ').trim()
  if (arg.length > 60) arg = `${arg.slice(0, 60)}…`
  return arg ? `${meta.icon} ${meta.verb} ${arg}` : `${meta.icon} ${meta.verb}`
}

// 这条 part 在某档位下是否要折成一行（thinking / 非 todos 工具）
function isCollapsible(part) {
  return part.kind === 'thinking' || part.kind === 'tool_use'
}

// 把原始 msgs 编排成「渲染指令」数组。
// 元素两种：
//   { type: 'msg', msg, partModes }   partModes 与 msg.parts 等长，每项 'show' | 'collapse'
//   { type: 'tool-group', parts, hasError }   talk 档把连续工具/thinking 归并的占位组
//
// 不变量：展开所有 tool-group 后，输出覆盖的 part 总数 == 输入 part 总数（不丢消息）。
export function planView(msgs, mode) {
  const list = Array.isArray(msgs) ? msgs : []

  if (mode === 'full') {
    return list.map((msg) => ({
      type: 'msg',
      msg,
      partModes: (msg.parts || []).map(() => 'show'),
    }))
  }

  if (mode === 'digest') {
    // text/todos 显示；thinking/tool_use 折成一行（可点开）
    return list.map((msg) => ({
      type: 'msg',
      msg,
      partModes: (msg.parts || []).map((p) => (isCollapsible(p) ? 'collapse' : 'show')),
    }))
  }

  // talk：part 粒度线性扫描。逐 part 决定「可见」还是「入占位组」，严格保持原始 part 顺序——
  // 这样消息内 text→tool→text 交错时工具会落在两段文本之间（BUG-1），
  // 跨消息的连续过程（工具/thinking）累积进同一个组、直到下一个可见 part 才 flush（BUG-2）。
  //
  // 节点两种：
  //   { type:'msg', role, msg, parts }   talk 下 parts 只含该可见运行段的 part，全部按 show 渲染；
  //                                       msg 为触发该段的源消息，渲染层据此取 key(seq)/兜底
  //   { type:'tool-group', parts, hasError }
  const out = []
  let group = null // 累积中的 tool-group
  let run = null // 累积中的可见运行段：{ type:'msg', role, parts:[] }

  const flushGroup = () => {
    if (group && group.parts.length) out.push(group)
    group = null
  }
  const flushRun = () => {
    if (run && run.parts.length) out.push(run)
    run = null
  }

  for (const msg of list) {
    const parts = msg.parts || []
    if (!parts.length) {
      // 无 parts 的消息（乐观追加 / 续话沉淀，只有 text 字段）：当作一条可见消息整体渲染
      flushGroup()
      flushRun()
      out.push({ type: 'msg', role: msg.role, msg, parts: [], partModes: [] })
      continue
    }
    for (const p of parts) {
      const visible = p.kind === 'text' || p.kind === 'todos'
      if (visible) {
        // 出现可见 part：先收掉累积的占位组（连续过程到此结束），再并进当前运行段
        flushGroup()
        if (!run || run.role !== msg.role) {
          flushRun()
          // 带上 msg：渲染层(TaskCard)用 item.msg 取稳定 key(msg.seq)并兜底 role/text，
          // 节点契约与 digest/full 及上面的无-parts 分支统一。漏了它会让 item.msg.seq 崩。
          run = { type: 'msg', role: msg.role, msg, parts: [], partModes: [] }
        }
        run.parts.push(p)
        run.partModes.push('show')
      } else {
        // 工具 / thinking：先收掉运行段（保持顺序），累积进占位组
        flushRun()
        if (!group) group = { type: 'tool-group', parts: [], hasError: false }
        group.parts.push(p)
        if (p.kind === 'tool_use' && p.result?.isError) group.hasError = true
      }
    }
  }
  flushRun()
  flushGroup()
  return out
}
