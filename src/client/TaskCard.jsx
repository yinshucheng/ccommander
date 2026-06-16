import React, { useState, useEffect, useRef } from 'react'
import { api, onConverse } from './api.js'
import { Markdown, MessagePart, CollapsedPart } from './parts.jsx'
import { foldReplyIntoHistory } from './converse-fold.js'
import { planView, VIEW_MODES, VIEW_MODE_LABEL, DEFAULT_MODE } from './view-mode.js'

// 批阅视图档位：全局共享一个开关（spec 012），存 localStorage，跨卡片同步。
const VIEW_MODE_KEY = 'commander.viewMode'
const viewModeListeners = new Set()
function readViewMode() {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY)
    return VIEW_MODES.includes(v) ? v : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}
function useViewMode() {
  const [mode, setMode] = useState(readViewMode)
  useEffect(() => {
    const fn = (m) => setMode(m)
    viewModeListeners.add(fn)
    return () => viewModeListeners.delete(fn)
  }, [])
  const set = (m) => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, m)
    } catch {
      /* ignore */
    }
    viewModeListeners.forEach((fn) => fn(m)) // 广播给所有挂载的卡片，保持全局一致
  }
  return [mode, set]
}

function age(ts) {
  if (!ts) return '—'
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}min`
  return `${(m / 60).toFixed(1)}h`
}

function clock(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 启动时间：ISO 字符串 → 「MM/DD HH:mm」（今天则只显示 HH:mm）
function datetime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return hh
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}`
}

const PRIORITY_CLASS = { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3' }

const LIVE = {
  waiting: { dot: '🟡', label: '可能在等你', cls: 'live-waiting' },
  completed: { dot: '✓', label: '已完成', cls: 'live-done' },
  running: { dot: '🔵', label: '在跑', cls: 'live-running' },
  idle: { dot: '⚪', label: '静默', cls: 'live-idle' },
}

const ROLE_LABEL = { user: '你', assistant: 'AI', tool: '⚙' }

// A-2：commander 走 stream-json（非 TTY）路径，**很多斜杠命令 claude 会直接拒绝**
// （返回 "/xxx isn't available in this environment."）。这是 claude CLI 的硬约束 ——
// 需要交互界面/picker/mode 切换的命令（/plan /model /clear /help /resume /agents
// /permissions /context /memory 等）在 stream-json 模式下都不工作。
//
// 这份列表是 2026-06 用 `echo /xxx | claude -p --output-format stream-json --verbose`
// 逐个实测筛出来的「在 commander 里真的能跑」的子集，不在此列的命令不要加。
// 验证脚本: scripts/test-slash-commands.sh（如需扩列表请先跑它复测）。
//
// 关于 Plan 模式：不是斜杠命令路径，需要 spawn 时带 `--permission-mode plan`。
// commander 走 ccr spawn 路线、目前不支持运行中切（需要 SDK in-process API），
// 见之前 review 的「选项 A 拿不到模式热切」。
const SLASH_COMMANDS = [
  { cmd: '/compact', desc: '压缩当前会话上下文' },
  { cmd: '/usage', desc: '查看 token / 调用统计' },
  { cmd: '/insights', desc: '生成会话洞察报告（输出 file:// 链接）' },
  { cmd: '/code-review', desc: '对当前 diff 跑代码评审' },
  { cmd: '/review', desc: '对 PR 跑代码评审（需 PR 号或当前 branch 有 PR）' },
  { cmd: '/security-review', desc: '对当前 diff 跑安全评审（需 git 仓库）' },
]

// 稍后(defer)的快捷档 → 换算成「从现在起多少分钟」。
// 今晚=今天 20:00（若已过则明天 20:00）；明早=次日 09:00。
// 一键默认档(deferDefault,来自配置)若不在固定档里则单列一档,且排首位。
function deferPresets(deferDefault = 30) {
  const now = new Date()
  const at = (h, m, dayOffset = 0) => {
    const d = new Date(now)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, m, 0, 0)
    return Math.max(1, Math.round((d - now) / 60000))
  }
  const tonightOffset = now.getHours() >= 20 ? 1 : 0
  const fixed = [
    { label: '15 分钟', minutes: 15 },
    { label: '30 分钟', minutes: 30 },
    { label: '1 小时', minutes: 60 },
    { label: '今晚 20:00', minutes: at(20, 0, tonightOffset) },
    { label: '明早 09:00', minutes: at(9, 0, 1) },
  ]
  if (!fixed.some((p) => p.minutes === deferDefault)) {
    fixed.unshift({ label: minutesLabel(deferDefault), minutes: deferDefault })
  }
  return fixed
}

// 把分钟数渲染成人话标签,供一键默认按钮用。
function minutesLabel(m) {
  if (m % 60 === 0) return `${m / 60} 小时`
  if (m < 60) return `${m} 分钟`
  return `${(m / 60).toFixed(1)} 小时`
}

// Source 插件骨架：按 type 分支渲染。本期只实现 claude，codex/web 占位。
function SourceView({ source, sid, liveState, onCtx }) {
  const type = source?.type || 'claude'
  if (type === 'web') {
    return source.url ? (
      <iframe className="source-iframe" src={source.url} title="web" />
    ) : (
      <div className="source-todo">（未配置网页 URL）</div>
    )
  }
  if (type === 'codex') {
    return <div className="source-todo">Codex 会话渲染即将支持（架构已预留）</div>
  }
  return <ContextView sid={sid} liveState={liveState} onCtx={onCtx} />
}

// Talk 档：被隐藏的连续工具/thinking 收成一条占位条，点击临时展开整组（spec 012）。
function ToolGroup({ group }) {
  const [open, setOpen] = useState(false)
  const toolCount = group.parts.filter((p) => p.kind === 'tool_use').length
  const label = toolCount
    ? `${toolCount} 个工具调用${group.hasError ? '（含失败）' : ''}`
    : `${group.parts.length} 条过程`
  if (open) {
    return (
      <div className="ctx-msg tool tool-group-open">
        <button className="tool-group-bar on" onClick={() => setOpen(false)}>
          <span className="collapsed-caret">▾</span>
          <span>{label}</span>
        </button>
        <div className="ctx-parts">
          {group.parts.map((p, j) => <MessagePart key={j} part={p} />)}
        </div>
      </div>
    )
  }
  return (
    <button className={`tool-group-bar${group.hasError ? ' err' : ''}`} onClick={() => setOpen(true)} title="点击展开">
      <span className="collapsed-caret">▸</span>
      <span>· {label}</span>
    </button>
  )
}

// 权限请求入参的紧凑摘要（普通工具用）
function permInputSummary(toolName, input) {
  if (!input || typeof input !== 'object') return ''
  const f = input.file_path || input.path || input.notebook_path
  if (f) return String(f).split('/').slice(-2).join('/')
  if (input.command) return String(input.command).slice(0, 80)
  if (input.pattern) return String(input.pattern).slice(0, 60)
  const keys = Object.keys(input)
  return keys.length ? `${keys.slice(0, 3).join(', ')}` : ''
}

// 一张权限审批/澄清/计划卡片（spec 015）。answer(decision) 回灌后由父级移除。
function PermissionCard({ perm, onAnswer }) {
  const { tool_name: tool, input } = perm
  const allow = (updatedInput) => onAnswer({ behavior: 'allow', ...(updatedInput ? { updatedInput } : {}) })
  const deny = (message) => onAnswer({ behavior: 'deny', message: message || '用户拒绝' })

  // L2 澄清：AskUserQuestion → 可选项卡片（答案经 updatedInput.answers 回填）
  if (tool === 'AskUserQuestion' && Array.isArray(input?.questions)) {
    return (
      <div className="perm-card perm-ask">
        <div className="perm-head">❓ 澄清</div>
        {input.questions.map((q, qi) => (
          <div className="perm-q" key={qi}>
            <div className="perm-q-text">{q.question}</div>
            <div className="perm-opts">
              {(q.options || []).map((o, oi) => (
                <button
                  key={oi}
                  className="perm-opt"
                  onClick={() =>
                    allow({ ...input, answers: { ...(input.answers || {}), [q.question]: o.label } })
                  }
                  title={o.description || ''}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // L2 计划：ExitPlanMode → 计划全文 + 批准/打回
  if (tool === 'ExitPlanMode' && input?.plan) {
    return (
      <div className="perm-card perm-plan">
        <div className="perm-head">📋 计划确认</div>
        <div className="perm-plan-body">
          <Markdown text={String(input.plan)} />
        </div>
        <div className="perm-actions">
          <button className="perm-allow" onClick={() => allow()}>批准计划</button>
          <button className="perm-deny" onClick={() => deny('用户打回计划')}>打回</button>
        </div>
      </div>
    )
  }

  // L1 普通工具：工具名 + 入参摘要 + 允许/拒绝。
  // A-3：可展开"改入参再批"（happy 同款 updatedInput）或"拒绝带说明"。
  return <ToolPermissionCard tool={tool} input={input} allow={allow} deny={deny} />
}

// A-3：可展开的工具权限卡。三档操作：
//   ① 一键允许（最常用）
//   ② 改入参后允许（happy 的 updatedInput；适合"路径写错了，帮我改一下再跑"）
//   ③ 拒绝并附说明（让 AI 知道为什么不让做）
function ToolPermissionCard({ tool, input, allow, deny }) {
  const [editing, setEditing] = useState(false)
  const [denying, setDenying] = useState(false)
  const [editJson, setEditJson] = useState('')
  const [editErr, setEditErr] = useState('')
  const [reason, setReason] = useState('')

  const openEditor = () => {
    setEditJson(JSON.stringify(input || {}, null, 2))
    setEditErr('')
    setEditing(true)
    setDenying(false)
  }
  const submitEdit = () => {
    let parsed
    try {
      parsed = JSON.parse(editJson)
    } catch (e) {
      setEditErr(`JSON 解析失败：${e.message}`)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setEditErr('入参必须是 JSON 对象')
      return
    }
    allow(parsed)
  }

  return (
    <div className="perm-card perm-tool">
      <div className="perm-head">
        🔐 请求使用 <b>{tool || '工具'}</b>
      </div>
      <div className="perm-input">{permInputSummary(tool, input)}</div>

      {/* 主操作行 */}
      {!editing && !denying && (
        <div className="perm-actions">
          <button className="perm-allow" onClick={() => allow()}>允许</button>
          <button className="perm-edit" onClick={openEditor} title="修改入参后允许（如改文件路径）">
            ✎ 改入参
          </button>
          <button className="perm-deny" onClick={() => setDenying(true)}>拒绝并说明</button>
        </div>
      )}

      {/* 改入参 */}
      {editing && (
        <div className="perm-edit-box">
          <div className="perm-edit-head">编辑入参（JSON）：</div>
          <textarea
            className="perm-edit-input"
            value={editJson}
            onChange={(e) => setEditJson(e.target.value)}
            spellCheck={false}
            rows={Math.min(12, Math.max(4, editJson.split('\n').length))}
          />
          {editErr && <div className="perm-edit-err">{editErr}</div>}
          <div className="perm-actions">
            <button className="perm-allow" onClick={submitEdit}>用此入参允许</button>
            <button className="perm-deny" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      )}

      {/* 拒绝并说明 */}
      {denying && (
        <div className="perm-edit-box">
          <div className="perm-edit-head">告诉 AI 为什么不让做（可空，留空则默认"用户拒绝"）：</div>
          <textarea
            className="perm-edit-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="比如：这个文件不能动 / 路径不对 / 先做另一件事"
            rows={3}
          />
          <div className="perm-actions">
            <button className="perm-deny" onClick={() => deny(reason.trim())}>提交拒绝</button>
            <button className="perm-allow" onClick={() => setDenying(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ContextView({ sid, liveState, onCtx }) {
  const [viewMode, setViewMode] = useViewMode() // 批阅档位（全局共享）
  const [ctx, setCtx] = useState(null)
  const [msgs, setMsgs] = useState([]) // 已加载的历史消息（含上翻的）
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // 续话
  const [input, setInput] = useState('')
  const [images, setImages] = useState([]) // 待发送图片 [{ name, dataUrl }]
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState('') // 流式拼接的回复
  const [sendErr, setSendErr] = useState(null)
  // 待你审批/作答的权限请求（spec 015）：[{ tool_use_id, tool_name, input }]
  const [perms, setPerms] = useState([])
  // 第 4 项：thinking 实时态（fd3 fetch 心跳或 stream-json 流入）
  const [thinking, setThinking] = useState(false)
  // 第 5 项：长驻进程死了 → 显示重启横幅（diedReason 是字符串；stderrTail/hint 来自重启失败响应）
  const [diedReason, setDiedReason] = useState(null)
  const [diedStderr, setDiedStderr] = useState('')
  const [restartHint, setRestartHint] = useState('')
  // 第 3 项：sid 因 /compact/fork 变更，给个非阻塞的提示
  const [migratedTo, setMigratedTo] = useState(null)
  const [restarting, setRestarting] = useState(false)
  // A-2：斜杠下拉（input 开头 "/" 时显示候选）
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIdx, setSlashIdx] = useState(0)

  const replyRef = useRef('') // 与 reply 同步，done 时读它沉淀历史（避免 setState updater 里嵌套副作用）
  const scrollRef = useRef(null) // 滚动容器
  const anchorRef = useRef(null) // 上翻加载时保持滚动位置用的锚点
  const atBottomRef = useRef(true) // 续话/新消息时是否自动贴底
  const taRef = useRef(null) // 续话输入框，用于多行自动撑高

  // 多行自动撑高：先归零再贴 scrollHeight，上限 200px（超出内部滚动），防止挤爆面板
  const autosize = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const canSend = liveState !== 'running' && !sending

  // 初次加载最近 10 条
  useEffect(() => {
    if (!sid) return
    let cancelled = false
    setLoading(true)
    setCtx(null)
    setMsgs([])
    replyRef.current = ''
    setReply('')
    setSendErr(null)
    setSending(false)
    setInput('')
    setPerms([])
    setThinking(false)
    setDiedReason(null)
    setDiedStderr('')
    setRestartHint('')
    setMigratedTo(null)
    setRestarting(false)
    atBottomRef.current = true
    api
      .context(sid, { limit: 10 })
      .then((c) => {
        if (cancelled) return
        setCtx(c)
        setMsgs(c.found ? c.recentMessages : [])
        onCtx?.(c) // 上报给父级，供右栏展示会话统计
      })
      .catch(() => {
        if (cancelled) return
        setCtx({ found: false })
        onCtx?.({ found: false })
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [sid])

  // 初次/切换会话加载完成后滚到底（最新消息）
  useEffect(() => {
    if (loading || !ctx?.found) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [loading, ctx?.found, sid])

  // 订阅本会话的续话流式增量
  useEffect(() => {
    if (!sid) return
    return onConverse((m) => {
      if (m.sid !== sid) return
      // 第 4 项：thinking
      if (m.type === 'thinking') {
        setThinking(!!m.thinking)
        return
      }
      // A-1：本轮被中断 —— 立刻收尾，回复区追加一条灰色「用户中断」标记
      if (m.type === 'turn-aborted') {
        if (sending) {
          // 把流式 reply 落盘成一条历史（防止丢字），再追加中断标记
          setMsgs((prev) => {
            const folded = foldReplyIntoHistory(prev, replyRef.current, Date.now())
            return [
              ...folded,
              { seq: -1, role: 'tool', text: m.escalated ? '[用户强制中断（SIGTERM）]' : '[用户中断本轮]', ts: Date.now() },
            ]
          })
          replyRef.current = ''
          setReply('')
          setSending(false)
        }
        setThinking(false)
        return
      }
      // 第 5 项：会话进程死了 —— 弹横幅，提供重启按钮
      if (m.type === 'session-died') {
        setDiedReason(m.reason || 'closed')
        setDiedStderr(m.stderrTail || '')
        setThinking(false)
        return
      }
      if (m.type === 'session-restarted') {
        setDiedReason(null)
        setDiedStderr('')
        setRestartHint('')
        setRestarting(false)
        return
      }
      // 第 3 项：sid 因 /compact/fork 变了 —— 提示一下；下次切会话时面板会重载到新 sid
      if (m.type === 'session-migrated' || m.type === 'session_aliased') {
        const newSid = m.newSid || m.sid
        if (newSid && newSid !== sid) setMigratedTo(newSid)
        return
      }
      // 权限审批/澄清/计划请求 → 入待办；落定 → 移除
      if (m.type === 'permission_request') {
        setPerms((prev) =>
          prev.some((p) => p.tool_use_id === m.tool_use_id)
            ? prev
            : [...prev, { tool_use_id: m.tool_use_id, tool_name: m.tool_name, input: m.input }]
        )
        return
      }
      if (m.type === 'permission_resolved') {
        setPerms((prev) => prev.filter((p) => p.tool_use_id !== m.tool_use_id))
        return
      }
      if (m.phase === 'delta') {
        replyRef.current += m.text
        setReply((r) => r + m.text)
      } else if (m.phase === 'done') {
        setSending(false)
        if (m.ok === false && m.error) setSendErr(m.error)
        // 把这轮 AI 回复沉淀进历史，再清空流式缓冲 —— 否则下一轮 setReply('') 会清掉它，
        // 多轮澄清就此断裂（specs/010）。从 replyRef 读最新文本，避免 setState updater 里嵌套副作用。
        setMsgs((prev) => foldReplyIntoHistory(prev, replyRef.current, Date.now()))
        replyRef.current = ''
        setReply('')
      }
    })
  }, [sid])

  const loadMore = () => {
    if (!ctx || !msgs.length || loadingMore || !ctx.hasMore) return
    setLoadingMore(true)
    // 记录加载前的滚动锚点：插入历史后把视口补偿回原处，避免跳动
    const el = scrollRef.current
    anchorRef.current = el ? el.scrollHeight - el.scrollTop : null
    api
      .context(sid, { limit: 10, before: msgs[0].seq })
      .then((c) => {
        if (c.found && c.recentMessages.length) {
          setMsgs((prev) => [...c.recentMessages, ...prev])
          setCtx((p) => ({ ...p, hasMore: c.hasMore }))
        } else {
          setCtx((p) => ({ ...p, hasMore: false }))
        }
      })
      .finally(() => setLoadingMore(false))
  }

  // 前置插入历史后恢复滚动位置（用 layout effect 在绘制前补偿，无闪烁）
  React.useLayoutEffect(() => {
    if (anchorRef.current == null) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight - anchorRef.current
    anchorRef.current = null
  }, [msgs])

  // 滚动监听：贴近顶部自动加载更早；记录是否贴底（供续话自动跟随）
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 60 && ctx?.hasMore && !loadingMore) loadMore()
  }

  // 续话流式增量 / 乐观追加用户消息时，若原本贴底则继续贴底跟随
  useEffect(() => {
    if (!atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [reply, msgs.length])

  const doSend = () => {
    const text = input.trim()
    const imgs = images
    if ((!text && !imgs.length) || !canSend) return
    setSending(true)
    replyRef.current = ''
    setReply('')
    setSendErr(null)
    // 乐观把用户消息追加到历史（带图片张数提示）
    const optimistic = imgs.length ? `${text}${text ? ' ' : ''}[🖼️ ${imgs.length} 张图片]` : text
    setMsgs((prev) => [...prev, { seq: -1, role: 'user', text: optimistic, ts: Date.now() }])
    setInput('')
    setImages([])
    requestAnimationFrame(autosize) // 清空后收回高度
    api.send(sid, text, imgs).catch((e) => {
      setSending(false)
      setSendErr(e.message === 'HTTP 409' ? '该会话可能正在终端运行，无法网页续话' : '发送失败')
    })
  }

  // 回灌一条权限审批/澄清/计划的决定（spec 015）。乐观移除卡片；失败则恢复 + 提示。
  const answerPerm = (toolUseId, decision) => {
    const removed = perms.find((p) => p.tool_use_id === toolUseId)
    setPerms((prev) => prev.filter((p) => p.tool_use_id !== toolUseId))
    api.permission(sid, toolUseId, decision).catch(() => {
      if (removed) setPerms((prev) => [...prev, removed])
      setSendErr('回灌决定失败，请重试')
    })
  }

  // 粘贴图片：从剪贴板提取 image/* 项，转 base64 data URL 存入待发送列表
  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || [])
    const files = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean)
    if (!files.length) return
    e.preventDefault() // 阻止把图片二进制当文本贴进框
    for (const f of files) {
      const reader = new FileReader()
      reader.onload = () => setImages((prev) => [...prev, { name: f.name || 'pasted.png', dataUrl: reader.result }])
      reader.readAsDataURL(f)
    }
  }

  const removeImage = (i) => setImages((prev) => prev.filter((_, j) => j !== i))

  // A-2：根据当前 input 算斜杠候选
  const slashCandidates = (() => {
    const t = input
    if (!t.startsWith('/') || /\s/.test(t)) return []
    const lower = t.toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(lower))
  })()

  // input 改变时同步 slashOpen / 复位选中
  useEffect(() => {
    const open = slashCandidates.length > 0
    setSlashOpen(open)
    if (open) setSlashIdx((i) => Math.min(i, slashCandidates.length - 1))
  }, [input])

  const pickSlash = (i) => {
    const c = slashCandidates[i]
    if (!c) return
    // 命令后留一个空格，方便接参数（/model opus）；无参数的命令用户直接 Enter 发即可
    setInput(c.cmd + ' ')
    setSlashOpen(false)
    requestAnimationFrame(() => taRef.current?.focus())
  }

  // A-1：ESC = 中断本轮（仅在 sending 或 thinking 时生效；否则让 ESC 走默认行为）
  const doAbort = () => {
    if (!sid) return
    api
      .abort(sid)
      .then((r) => {
        if (r?.escalated) setSendErr('已升级为 SIGTERM 强制中断；如仍无响应可重启会话')
      })
      .catch((e) => setSendErr(`中断失败: ${e.message}`))
  }

  const onKeyDown = (e) => {
    // A-2：斜杠下拉打开时优先消费方向/Enter/Esc
    if (slashOpen && slashCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (i + 1) % slashCandidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (i - 1 + slashCandidates.length) % slashCandidates.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault()
        pickSlash(slashIdx)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      doSend()
      return
    }
    if (e.key === 'Escape' && (sending || thinking)) {
      e.preventDefault()
      doAbort()
    }
  }

  if (loading) return <div className="ctx-loading">加载上下文…</div>
  if (!ctx || !ctx.found) return <div className="ctx-empty">（无 transcript）</div>

  return (
    <div className="ctx">
      <div className="ctx-recent">
        <div className="ctx-recent-head">
          <span>
            历史 {msgs.length} / 共 {ctx.total} 条
            {thinking && <span className="thinking-pill" title="检测到正在调用模型/工具">● 正在思考</span>}
          </span>
          <div className="view-seg" role="tablist" aria-label="批阅视图">
            {VIEW_MODES.map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={viewMode === m}
                className={`view-seg-btn${viewMode === m ? ' on' : ''}`}
                onClick={() => setViewMode(m)}
              >
                {VIEW_MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>

        <div className="ctx-scroll" ref={scrollRef} onScroll={onScroll}>
          {ctx.hasMore ? (
            <div className="load-more-hint">{loadingMore ? '加载更早的消息…' : '↑ 上滑加载更早'}</div>
          ) : (
            msgs.length > 0 && <div className="load-more-hint done">— 已到最早 —</div>
          )}

          {planView(msgs, viewMode).map((item, i) => {
            if (item.type === 'tool-group') return <ToolGroup key={`g-${i}`} group={item} />
            const m = item.msg
            const role = item.role || m.role
            // talk 档节点自带可见 part 子集(item.parts)；digest/full 用整条 msg.parts。
            const parts = item.parts != null ? item.parts : Array.isArray(m.parts) ? m.parts : []
            const partModes = item.partModes || []
            return (
              <div key={`${m.seq}-${i}`} className={`ctx-msg ${role}`}>
                <span className="ctx-role">{ROLE_LABEL[role] || role}</span>
                <div className="ctx-parts">
                  {parts.length ? (
                    parts.map((p, j) => {
                      const mode = partModes[j] || 'show'
                      if (mode === 'collapse') return <CollapsedPart key={j} part={p} />
                      return <MessagePart key={j} part={p} />
                    })
                  ) : (
                    <Markdown text={m.text} />
                  )}
                </div>
              </div>
            )
          })}

          {(sending || reply) && (
            <div className="ctx-msg assistant streaming">
              <span className="ctx-role">AI</span>
              <span className="ctx-text">
                {reply ? <Markdown text={reply} /> : '思考中…'}
                {sending && <span className="cursor">▋</span>}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 第 5 项：长驻进程死了，弹一条非阻塞横幅 + 重启按钮 */}
      {diedReason && (
        <div className="conv-banner died">
          <div className="died-main">
            <div>
              <span>⚠ 会话进程已退出（{diedReason}）。可重启续话，原 transcript 不丢。</span>
              {restartHint && <div className="died-hint">{restartHint}</div>}
            </div>
            <button
              className="conv-restart"
              disabled={restarting}
              onClick={() => {
                setRestarting(true)
                setRestartHint('')
                api
                  .restart(sid)
                  .then((r) => {
                    setRestarting(false)
                    if (r && r.ok) return // ws session-restarted 会清横幅
                    // 重启失败：保留横幅，把 stderr 和退避提示展示给用户
                    if (r?.stderrTail) setDiedStderr(r.stderrTail)
                    if (r?.hint) setRestartHint(r.hint)
                    setDiedReason(r?.error || 'restart failed')
                  })
                  .catch((e) => {
                    setRestarting(false)
                    setRestartHint(`重启请求失败: ${e.message}`)
                  })
              }}
            >
              {restarting ? '重启中…' : '🔁 重启会话'}
            </button>
          </div>
          {diedStderr && (
            <pre className="died-stderr" title="子进程 stderr 末尾">
              {diedStderr}
            </pre>
          )}
        </div>
      )}

      {/* 第 3 项：sid 因 /compact/fork 迁移，给个一次性提示（不打断操作） */}
      {migratedTo && !diedReason && (
        <div className="conv-banner migrated">
          <span>ℹ 会话已迁移到新 sid（{migratedTo.slice(0, 8)}…）—— /compact 或 fork 后续仍走同一进程。</span>
          <button className="conv-restart" onClick={() => setMigratedTo(null)}>知道了</button>
        </div>
      )}

      {/* 权限审批/澄清/计划卡片（spec 015）：即便会话 running 也显示，这正是「该问你时弹给你」 */}
      {perms.length > 0 && (
        <div className="perm-list">
          {perms.map((p) => (
            <PermissionCard key={p.tool_use_id} perm={p} onAnswer={(d) => answerPerm(p.tool_use_id, d)} />
          ))}
        </div>
      )}

      {/* 续话输入框 */}
      <div className="converse">
        {liveState === 'running' ? (
          <div className="converse-locked">
            🔵 该会话可能正在终端运行，网页续话已禁用。可复制上面的命令进完整 session。
          </div>
        ) : (
          <div className="converse-box">
            {images.length > 0 && (
              <div className="converse-thumbs">
                {images.map((img, i) => (
                  <div className="converse-thumb" key={i}>
                    <img src={img.dataUrl} alt={img.name} />
                    <button className="converse-thumb-del" onClick={() => removeImage(i)} title="移除">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* A-2：斜杠候选下拉 —— input 开头 "/" 时弹 */}
            {slashOpen && slashCandidates.length > 0 && (
              <div className="slash-menu" role="listbox">
                {slashCandidates.map((c, i) => (
                  <div
                    key={c.cmd}
                    role="option"
                    aria-selected={i === slashIdx}
                    className={`slash-item${i === slashIdx ? ' active' : ''}`}
                    onMouseEnter={() => setSlashIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault() // 防止 textarea 失焦
                      pickSlash(i)
                    }}
                  >
                    <span className="slash-cmd">{c.cmd}</span>
                    <span className="slash-desc">{c.desc}</span>
                  </div>
                ))}
                <div className="slash-hint">↑↓ 选择 · Tab/Enter 填充 · Esc 关闭</div>
              </div>
            )}
            <textarea
              ref={taRef}
              className="converse-input"
              placeholder="直接回复这个会话…（输入 / 看命令 · ⌘/Ctrl + Enter 发送）"
              value={input}
              disabled={sending}
              onChange={(e) => {
                setInput(e.target.value)
                autosize()
              }}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
            />
            {sendErr && <span className="converse-err">{sendErr}</span>}
            {/* A-1：发送中/思考中 → 按钮换成"中断 ESC"，否则正常发送。
                单独按钮而不只靠键盘，是因为粘贴图片场景焦点不一定在 textarea */}
            {sending || thinking ? (
              <button
                className="converse-send abort"
                onClick={doAbort}
                title="中断本轮（ESC）"
              >
                ⏹ 中断 ESC
              </button>
            ) : (
              <button
                className="converse-send"
                onClick={doSend}
                disabled={!input.trim() && !images.length}
                title="发送 ⌘/Ctrl + Enter"
              >
                发送 ⌘↵
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 右栏：该 session 的元信息 + 最初意图 + 分析进展 + 操作。ctx 来自左栏 ContextView 上报。
function MetaColumn({ task, session, ctx, live, onAct, api, deferDefault = 30, analysis, analyzing, onAnalyze }) {
  const [copied, setCopied] = useState(false)
  const [deferOpen, setDeferOpen] = useState(false)
  const tt = task.title || '(未命名任务)'
  // 合并「进目录 + 接续命令」：复制一条 `cd <dir> && <command>`，任意终端粘贴即进目录续会话。
  const enterCmd =
    session?.workingDir && session?.command
      ? `cd ${session.workingDir} && ${session.command}`
      : session?.command || ''
  const copyCmd = () => {
    navigator.clipboard?.writeText(enterCmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <aside className="col-meta">
      <div className="meta-badges">
        {live && <span className={`badge ${live.cls}`}>{live.dot} {live.label}</span>}
        <span className={`badge ${PRIORITY_CLASS[task.priority]}`}>{task.priority}</span>
      </div>

      {(ctx?.firstMessage?.text || task.title) && (
        <div className="meta-intent">
          <div className="meta-intent-tag">最初意图</div>
          <div className="meta-intent-text">{ctx?.firstMessage?.text || task.title}</div>
        </div>
      )}

      <div className="meta-stats">
        {ctx?.startedAt && (
          <div className="stat">
            <span className="stat-k">启动</span>
            <span className="stat-v">{datetime(ctx.startedAt)}</span>
          </div>
        )}
        {typeof ctx?.userTurns === 'number' && (
          <div className="stat">
            <span className="stat-k">对话轮次</span>
            <span className="stat-v">{ctx.userTurns} 轮</span>
          </div>
        )}
        {typeof ctx?.uncompactedTurns === 'number' && (
          <div className="stat">
            <span className="stat-k">未压缩</span>
            <span className="stat-v">
              {ctx.uncompactedTurns} 轮
              {ctx.compactCount > 0 && <span className="stat-sub"> · 压缩{ctx.compactCount}次</span>}
            </span>
          </div>
        )}
        <div className="stat">
          <span className="stat-k">等待</span>
          <span className="stat-v">{age(task.queuedAt)}</span>
        </div>
        {session?.lastEventAt && (
          <div className="stat">
            <span className="stat-k">活动</span>
            <span className="stat-v">{age(session.lastEventAt)}前</span>
          </div>
        )}
        {session?.projectName && (
          <div className="stat">
            <span className="stat-k">项目</span>
            <span className="stat-v">{session.projectName}</span>
          </div>
        )}
        {session?.gitBranch && (
          <div className="stat">
            <span className="stat-k">分支</span>
            <span className="stat-v">⎇ {session.gitBranch}</span>
          </div>
        )}
        {task.skipCount > 0 && (
          <div className="stat">
            <span className="stat-k">跳过</span>
            <span className="stat-v">{task.skipCount} 次</span>
          </div>
        )}
      </div>

      {session?.workingDir && (
        <div className="meta-dir" title={session.workingDir}>
          📁 {session.workingDir}
        </div>
      )}

      {enterCmd && (
        <button
          className="meta-copy"
          onClick={copyCmd}
          title={`复制后任意终端粘贴即进目录续会话：\n${enterCmd}`}
        >
          {copied ? '✓ 已复制（cd + 接续命令）' : '📋 复制进入命令'}
        </button>
      )}

      {session?.claudeSessionId && (
        <>
          <button className="analyze-btn meta-analyze" onClick={onAnalyze} disabled={analyzing}>
            {analyzing ? '分析中…' : '🔍 分析进展'}
          </button>
          {analysis && (
            <div className={`analysis ${analysis.ok ? '' : 'err'}`}>
              {analysis.ok ? (
                <>
                  <div className="an-head">
                    <b>{analysis.stage}</b>
                    {analysis.provider === 'llm' && (
                      <span className="an-badge">{analysis.model?.split('/').pop() || 'LLM'}</span>
                    )}
                  </div>
                  {analysis.summary && <div className="an-sum">{analysis.summary}</div>}
                  {analysis.blocker && (
                    <div className="an-row">
                      <span className="an-k">卡点</span>
                      <span>{analysis.blocker}</span>
                    </div>
                  )}
                  {analysis.nextStep && (
                    <div className="an-row">
                      <span className="an-k">下一步</span>
                      <span>{analysis.nextStep}</span>
                    </div>
                  )}
                  {analysis.note && <div className="an-note">{analysis.note}</div>}
                </>
              ) : (
                <span>{analysis.reason}</span>
              )}
            </div>
          )}
        </>
      )}

      <div className="meta-rule" />

      <div className="actions-col">
        <button
          className="act done"
          title="处理完了，移出队列。除非该会话之后又冒出新的 waiting，否则不再出现"
          onClick={() => onAct(() => api.done(task.id), { kind: 'done', title: tt })}
        >
          ✓ 完成 <kbd>Enter</kbd>
        </button>
        <button
          className="act skip"
          title="现在不处理，降权重排到同档末尾。仍在队列里，稍后会再轮到"
          onClick={() =>
            onAct(
              () => api.skip(task.id).then((r) => ({ undo: () => api.unskip(task.id, r?._prev) })),
              { kind: 'skip', title: tt }
            )
          }
        >
          → 跳过 <kbd>S</kbd>
        </button>
        {deferOpen ? (
          <div className="defer-presets">
            {deferPresets(deferDefault).map((p) => (
              <button
                key={p.label}
                className="defer-preset"
                onClick={() => {
                  setDeferOpen(false)
                  onAct(() => api.defer(task.id, p.minutes), { kind: 'defer', title: tt })
                }}
              >
                {p.label}
              </button>
            ))}
            <button className="defer-preset cancel" onClick={() => setDeferOpen(false)}>
              取消
            </button>
          </div>
        ) : (
          <div className="defer-split">
            <button
              className="act defer"
              title={`一键推迟 ${minutesLabel(deferDefault)}(默认值,可在设置里改),到点自动回来`}
              onClick={() => onAct(() => api.defer(task.id, deferDefault), { kind: 'defer', title: tt })}
            >
              ⏰ 稍后 {minutesLabel(deferDefault)} <kbd>L</kbd>
            </button>
            <button
              className="act defer-more"
              title="选其他时长"
              onClick={() => setDeferOpen(true)}
            >
              其他…
            </button>
          </div>
        )}
        <button
          className="act dismiss"
          title="不再处理这个会话。比「完成」更强：移除后即使会话还活着也不复活（除非来新的 waiting）"
          onClick={() => onAct(() => api.dismiss(task.id), { kind: 'dismiss', title: tt })}
        >
          ✕ 移除 <kbd>D</kbd>
        </button>
      </div>
    </aside>
  )
}

const META_W_KEY = 'commander.metaColWidth'

export default function TaskCard({ task, onAct, api, deferDefault = 30 }) {
  const live = task.liveState ? LIVE[task.liveState] : null
  const sessions = task.sessionDetails || []
  const [active, setActive] = useState(0)
  const [ctx, setCtx] = useState(null) // 左栏 ContextView 上报的会话统计，供右栏用
  const [analysis, setAnalysis] = useState(null) // 分析进展结果（已移到右栏展示）
  const [analyzing, setAnalyzing] = useState(false)
  const idx = Math.min(active, Math.max(0, sessions.length - 1))
  const s = sessions[idx]

  // 切换任务/会话时清掉旧统计/分析，避免右栏短暂显示上一会话的内容
  useEffect(() => {
    setCtx(null)
    setAnalysis(null)
    setAnalyzing(false)
  }, [task.id, s?.claudeSessionId])

  const runAnalyze = () => {
    const sid = s?.claudeSessionId
    if (!sid) return
    setAnalyzing(true)
    api
      .analyze(sid)
      .then(setAnalysis)
      .catch(() => setAnalysis({ ok: false, reason: '分析失败' }))
      .finally(() => setAnalyzing(false))
  }

  // 右栏宽度（可拖拽，记忆到 localStorage）
  const [metaW, setMetaW] = useState(() => {
    const v = parseInt(localStorage.getItem(META_W_KEY) || '', 10)
    return Number.isFinite(v) && v >= 240 && v <= 560 ? v : 320
  })
  const dragRef = useRef(null)
  const onResizeStart = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = metaW
    const onMove = (ev) => {
      // 手柄在左右栏之间：往左拖 → 右栏变宽
      const next = Math.min(560, Math.max(240, startW + (startX - ev.clientX)))
      setMetaW(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      setMetaW((w) => {
        localStorage.setItem(META_W_KEY, String(w))
        return w
      })
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="task-card two-col" style={{ '--meta-w': `${metaW}px` }}>
      <div className="col-history">
        {sessions.length > 1 && (
          <div className="history-head">
            <div className="session-tabs">
              {sessions.map((x, i) => (
                <button
                  key={x.id}
                  className={i === idx ? 'tab active' : 'tab'}
                  onClick={() => setActive(i)}
                >
                  {x.label || `${x.agentType} ${i + 1}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {sessions.length === 0 ? (
          <div className="session-empty">（无关联 session）</div>
        ) : (
          <SourceView
            key={s.claudeSessionId}
            source={s.source || { type: 'claude' }}
            sid={s.claudeSessionId}
            liveState={s.liveState}
            onCtx={setCtx}
          />
        )}
      </div>

      <div className="col-resizer" ref={dragRef} onMouseDown={onResizeStart} title="拖动调节宽度" />

      <MetaColumn
        task={task}
        session={s}
        ctx={ctx}
        live={live}
        onAct={onAct}
        api={api}
        deferDefault={deferDefault}
        analysis={analysis}
        analyzing={analyzing}
        onAnalyze={runAnalyze}
      />
    </div>
  )
}
