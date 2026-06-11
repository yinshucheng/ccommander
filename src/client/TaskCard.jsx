import React, { useState, useEffect, useRef } from 'react'
import { api, onConverse } from './api.js'
import { Markdown, MessagePart } from './parts.jsx'
import { foldReplyIntoHistory } from './converse-fold.js'

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

function ContextView({ sid, liveState, onCtx }) {
  const [ctx, setCtx] = useState(null)
  const [msgs, setMsgs] = useState([]) // 已加载的历史消息（含上翻的）
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  // 续话
  const [input, setInput] = useState('')
  const [images, setImages] = useState([]) // 待发送图片 [{ name, dataUrl }]
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState('') // 流式拼接的回复
  const [sendErr, setSendErr] = useState(null)

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
    setAnalysis(null)
    replyRef.current = ''
    setReply('')
    setSendErr(null)
    setSending(false)
    setInput('')
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

  const runAnalyze = () => {
    setAnalyzing(true)
    api
      .analyze(sid)
      .then(setAnalysis)
      .catch(() => setAnalysis({ ok: false, reason: '分析失败' }))
      .finally(() => setAnalyzing(false))
  }

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

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      doSend()
    }
  }

  if (loading) return <div className="ctx-loading">加载上下文…</div>
  if (!ctx || !ctx.found) return <div className="ctx-empty">（无 transcript）</div>

  return (
    <div className="ctx">
      {ctx.firstMessage && (
        <div className="ctx-first">
          <span className="ctx-tag">最初意图</span>
          <span className="ctx-first-text">{ctx.firstMessage.text}</span>
        </div>
      )}

      <div className="ctx-recent">
        <div className="ctx-recent-head">
          <span>
            历史 {msgs.length} / 共 {ctx.total} 条
          </span>
          <button className="analyze-btn" onClick={runAnalyze} disabled={analyzing}>
            {analyzing ? '分析中…' : '🔍 分析进展'}
          </button>
        </div>

        <div className="ctx-scroll" ref={scrollRef} onScroll={onScroll}>
          {ctx.hasMore ? (
            <div className="load-more-hint">{loadingMore ? '加载更早的消息…' : '↑ 上滑加载更早'}</div>
          ) : (
            msgs.length > 0 && <div className="load-more-hint done">— 已到最早 —</div>
          )}

          {msgs.map((m, i) => (
          <div key={`${m.seq}-${i}`} className={`ctx-msg ${m.role}`}>
            <span className="ctx-role">{ROLE_LABEL[m.role] || m.role}</span>
            <div className="ctx-parts">
              {Array.isArray(m.parts) && m.parts.length ? (
                m.parts.map((p, j) => <MessagePart key={j} part={p} />)
              ) : (
                <Markdown text={m.text} />
              )}
            </div>
          </div>
        ))}

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

      {analysis && (
        <div className={`analysis ${analysis.ok ? '' : 'err'}`}>
          {analysis.ok ? (
            <>
              <div className="an-head">
                <b>{analysis.stage}</b>
                {analysis.provider === 'llm' && <span className="an-badge">{analysis.model?.split('/').pop() || 'LLM'}</span>}
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
            <textarea
              ref={taRef}
              className="converse-input"
              placeholder="直接回复这个会话…（可粘贴图片 · ⌘/Ctrl + Enter 发送）"
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
            <button
              className="converse-send"
              onClick={doSend}
              disabled={(!input.trim() && !images.length) || sending}
              title="发送 ⌘/Ctrl + Enter"
            >
              {sending ? '发送中…' : '发送 ⌘↵'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// 右栏：该 session 的元信息 + 操作。ctx 来自左栏 ContextView 上报的会话统计。
function MetaColumn({ task, session, ctx, live, onAct, api, deferDefault = 30 }) {
  const [copied, setCopied] = useState(false)
  const [deferOpen, setDeferOpen] = useState(false)
  const copyCmd = () => {
    navigator.clipboard?.writeText(session?.command || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <aside className="col-meta">
      <div className="meta-badges">
        {live && <span className={`badge ${live.cls}`}>{live.dot} {live.label}</span>}
        <span className={`badge ${PRIORITY_CLASS[task.priority]}`}>{task.priority}</span>
      </div>

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
        <div
          className="meta-dir"
          title={`点击复制目录路径\n${session.workingDir}`}
          onClick={() => navigator.clipboard?.writeText(session.workingDir)}
        >
          📁 {session.workingDir}
        </div>
      )}

      {session?.command && (
        <button className="meta-copy" onClick={copyCmd}>
          {copied ? '✓ 已复制接续命令' : '📋 复制接续命令'}
        </button>
      )}

      <div className="meta-rule" />

      <div className="actions-col">
        <button
          className="act done"
          title="处理完了，移出队列。除非该会话之后又冒出新的 waiting，否则不再出现"
          onClick={() => onAct(() => api.done(task.id))}
        >
          ✓ 完成 <kbd>Enter</kbd>
        </button>
        <button
          className="act skip"
          title="现在不处理，降权重排到同档末尾。仍在队列里，稍后会再轮到"
          onClick={() => onAct(() => api.skip(task.id))}
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
                  onAct(() => api.defer(task.id, p.minutes))
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
              onClick={() => onAct(() => api.defer(task.id, deferDefault))}
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
          onClick={() => onAct(() => api.dismiss(task.id))}
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
  const idx = Math.min(active, Math.max(0, sessions.length - 1))
  const s = sessions[idx]

  // 切换任务/会话时清掉旧统计，避免右栏短暂显示上一会话的数字
  useEffect(() => {
    setCtx(null)
  }, [task.id, s?.claudeSessionId])

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
        <div className="history-head">
          <h1 className="task-title">{task.title || '(未命名任务)'}</h1>
          {task.context && <p className="task-context">{task.context}</p>}
          {sessions.length > 1 && (
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
          )}
        </div>

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

      <MetaColumn task={task} session={s} ctx={ctx} live={live} onAct={onAct} api={api} deferDefault={deferDefault} />
    </div>
  )
}
