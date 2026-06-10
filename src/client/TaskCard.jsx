import React, { useState, useEffect, useRef } from 'react'
import { api, onConverse } from './api.js'
import { Markdown, MessagePart } from './parts.jsx'

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

const PRIORITY_CLASS = { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3' }

const LIVE = {
  waiting: { dot: '🟡', label: '可能在等你', cls: 'live-waiting' },
  completed: { dot: '✓', label: '已完成', cls: 'live-done' },
  running: { dot: '🔵', label: '在跑', cls: 'live-running' },
  idle: { dot: '⚪', label: '静默', cls: 'live-idle' },
}

const ROLE_LABEL = { user: '你', assistant: 'AI', tool: '⚙' }

// Source 插件骨架：按 type 分支渲染。本期只实现 claude，codex/web 占位。
function SourceView({ source, sid, liveState }) {
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
  return <ContextView sid={sid} liveState={liveState} />
}

function ContextView({ sid, liveState }) {
  const [ctx, setCtx] = useState(null)
  const [msgs, setMsgs] = useState([]) // 已加载的历史消息（含上翻的）
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  // 续话
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState('') // 流式拼接的回复
  const [sendErr, setSendErr] = useState(null)

  const canSend = liveState !== 'running' && !sending

  // 初次加载最近 10 条
  useEffect(() => {
    if (!sid) return
    let cancelled = false
    setLoading(true)
    setCtx(null)
    setMsgs([])
    setAnalysis(null)
    setReply('')
    setSendErr(null)
    setSending(false)
    setInput('')
    api
      .context(sid, { limit: 10 })
      .then((c) => {
        if (cancelled) return
        setCtx(c)
        setMsgs(c.found ? c.recentMessages : [])
      })
      .catch(() => !cancelled && setCtx({ found: false }))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [sid])

  // 订阅本会话的续话流式增量
  useEffect(() => {
    if (!sid) return
    return onConverse((m) => {
      if (m.sid !== sid) return
      if (m.phase === 'delta') setReply((r) => r + m.text)
      else if (m.phase === 'done') {
        setSending(false)
        if (m.ok === false && m.error) setSendErr(m.error)
        // 把这轮对话追加进历史（用户问 + AI 答）
      }
    })
  }, [sid])

  const loadMore = () => {
    if (!ctx || !msgs.length) return
    setLoadingMore(true)
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
    if (!text || !canSend) return
    setSending(true)
    setReply('')
    setSendErr(null)
    // 乐观把用户消息追加到历史
    setMsgs((prev) => [...prev, { seq: -1, role: 'user', text, ts: Date.now() }])
    setInput('')
    api.send(sid, text).catch((e) => {
      setSending(false)
      setSendErr(e.message === 'HTTP 409' ? '该会话可能正在终端运行，无法网页续话' : '发送失败')
    })
  }

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

        {ctx.hasMore && (
          <button className="load-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '↑ 更早的消息'}
          </button>
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
          <>
            <textarea
              className="converse-input"
              placeholder="直接回复这个会话…（⌘/Ctrl + Enter 发送）"
              value={input}
              disabled={sending}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="converse-actions">
              {sendErr && <span className="converse-err">{sendErr}</span>}
              <button className="converse-send" onClick={doSend} disabled={!input.trim() || sending}>
                {sending ? '发送中…' : '发送 ⌘↵'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SessionPanel({ sessions }) {
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  if (!sessions || sessions.length === 0) {
    return <div className="session-empty">（无关联 session）</div>
  }
  const idx = Math.min(active, sessions.length - 1)
  const s = sessions[idx]
  const copy = () => {
    navigator.clipboard?.writeText(s.command || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="session-panel">
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
      <div className="session-body">
        <div className="kv">
          <span className="k">目录</span>
          <span className="v mono">{s.workingDir || '—'}</span>
        </div>
        <div className="kv">
          <span className="k">接续</span>
          <span className="v mono cmd">
            {s.command || '—'}
            {s.command && (
              <button className="copy-btn" onClick={copy}>
                {copied ? '✓ 已复制' : '复制'}
              </button>
            )}
          </span>
        </div>
        <div className="ctx-section">
          <SourceView
            source={s.source || { type: 'claude' }}
            sid={s.claudeSessionId}
            liveState={s.liveState}
          />
        </div>
      </div>
    </div>
  )
}

export default function TaskCard({ task, onAct, api }) {
  const live = task.liveState ? LIVE[task.liveState] : null
  const s0 = task.sessionDetails?.[0]
  return (
    <div className="task-card">
      <div className="task-head">
        <h1 className="task-title">{task.title || '(未命名任务)'}</h1>
        <div className="badges">
          {live && <span className={`badge ${live.cls}`}>{live.dot} {live.label}</span>}
          <span className={`badge ${PRIORITY_CLASS[task.priority]}`}>{task.priority}</span>
        </div>
      </div>
      <div className="task-rule" />
      {task.context && <p className="task-context">{task.context}</p>}
      <div className="task-meta">
        ⏱️ 等待: {age(task.queuedAt)}
        {s0?.projectName && <> &nbsp;|&nbsp; 📁 {s0.projectName}</>}
        {s0?.gitBranch && <> &nbsp;|&nbsp; ⎇ {s0.gitBranch}</>}
        {s0?.lastEventAt && <> &nbsp;|&nbsp; 活动: {age(s0.lastEventAt)}前</>}
        {task.skipCount > 0 && <> &nbsp;|&nbsp; 跳过 {task.skipCount} 次</>}
      </div>

      <div className="session-section">
        <div className="section-label">Sessions</div>
        <SessionPanel sessions={task.sessionDetails} />
      </div>

      <div className="actions">
        <button className="act done" onClick={() => onAct(() => api.done(task.id))}>
          ✓ 完成 <kbd>Enter</kbd>
        </button>
        <button className="act skip" onClick={() => onAct(() => api.skip(task.id))}>
          → 跳过 <kbd>S</kbd>
        </button>
        <button className="act defer" onClick={() => onAct(() => api.defer(task.id, 60))}>
          ⏰ 稍后 <kbd>L</kbd>
        </button>
        <button className="act dismiss" onClick={() => onAct(() => api.dismiss(task.id))}>
          ✕ 移除 <kbd>D</kbd>
        </button>
      </div>
    </div>
  )
}
