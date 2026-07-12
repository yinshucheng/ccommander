import React, { useEffect, useRef, useState } from 'react'
import { groupTasks } from './board-group.js'
import PriorityBadge from './PriorityBadge.jsx'

function age(ts) {
  if (!ts) return ''
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}m`
  return `${(m / 60).toFixed(1)}h`
}

function deferLeft(ts) {
  const m = Math.ceil((ts - Date.now()) / 60000)
  if (m <= 0) return '即将'
  if (m < 60) return `${m}min后`
  return `${(m / 60).toFixed(1)}h后`
}

const LIVE_DOT = { waiting: '🟡', running: '🔵', idle: '⚪', completed: '✓' }

const DIMENSIONS = [
  { key: 'project', label: '项目' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
  { key: 'none', label: '不分组' },
]

const GROUPBY_KEY = 'commander.board.groupBy'

// 行内操作：done/skip/defer 复用 App 的 act（含 refresh + toast）。
function BoardRow({ t, api, onAct, onReview, deferDefault, deferred }) {
  const proj = (t.sessionDetails || [])[0]
  const projName = proj?.projectName
  const branch = proj?.gitBranch
  const sub = [projName, branch].filter(Boolean).join(' · ')
  const meta = { title: t.title || '(未命名任务)' }

  return (
    <div className="board-row">
      <span className="br-dot">{LIVE_DOT[t.liveState] || '•'}</span>
      <span className="br-prio">
        <PriorityBadge
          task={t}
          api={api}
          onChanged={(id, priority) => onAct(() => api.patchTask(id, { priority }))}
        />
      </span>
      <span className="br-title" title={t.title}>
        {t.title || '(无标题)'}
      </span>
      {sub && <span className="br-sub">{sub}</span>}
      {t.skipCount > 0 && (
        <span className="q-skip" title="被跳过次数">
          ↻{t.skipCount}
        </span>
      )}
      <span className="br-age">{deferred ? deferLeft(t.deferUntil) : age(t.queuedAt)}</span>
      <span className="br-acts">
        <button
          className="q-act"
          title="进批阅视图细看这个会话"
          onClick={() => onReview?.(t.id)}
        >
          📖 批阅
        </button>
        {deferred ? (
          <button
            className="q-act"
            title="提前唤回到队列"
            onClick={() => onAct(() => api.undefer(t.id))}
          >
            ↑唤回
          </button>
        ) : (
          <>
            <button
              className="q-act"
              title="标记完成 (Enter)"
              onClick={() => onAct(() => api.done(t.id), { kind: 'done', ...meta })}
            >
              ✓
            </button>
            <button
              className="q-act"
              title="跳过 (S)"
              onClick={() =>
                onAct(
                  () => api.skip(t.id).then((r) => ({ undo: () => api.unskip(t.id, r?._prev) })),
                  { kind: 'skip', ...meta }
                )
              }
            >
              →
            </button>
            <button
              className="q-act"
              title={`稍后 ${deferDefault} 分钟 (L)`}
              onClick={() =>
                onAct(() => api.defer(t.id, deferDefault), { kind: 'defer', ...meta })
              }
            >
              ⏰
            </button>
          </>
        )}
      </span>
    </div>
  )
}

// 分组头内联「＋ 新会话」：填一句首条消息，在该项目目录下 spawn 全新 claude 会话。
// 提交走 api.newSession（不 throw，返回 {ok,error}）；成功后 onDone 关闭并刷新队列。
function NewSessionInline({ workingDir, api, onDone, onCancel }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  async function submit() {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    setErr(null)
    const r = await api.newSession({ workingDir, text: t })
    setBusy(false)
    if (r?.ok) onDone()
    else setErr(r?.error || '启动失败')
  }

  return (
    <div className="ns-inline">
      <div className="ns-dir" title={workingDir}>
        {workingDir}
      </div>
      <textarea
        ref={ref}
        className="ns-text"
        rows={2}
        placeholder="给新会话的第一句话…（Enter 提交，Esc 取消）"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {err && <div className="ns-err">{err}</div>}
      <div className="ns-acts">
        <button className="q-act" disabled={busy || !text.trim()} onClick={submit}>
          {busy ? '启动中…' : '⚡ 启动'}
        </button>
        <button className="q-act" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

export default function Board({ queue, api, onAct, onReview, deferDefault = 30, scrollTo, onScrolled }) {
  const [groupBy, setGroupBy] = useState(
    () => localStorage.getItem(GROUPBY_KEY) || 'project'
  )
  // 当前展开「＋ 新会话」输入的分组 key（同时只开一个）
  const [openProj, setOpenProj] = useState(null)
  const waitingRef = useRef(null)

  useEffect(() => {
    localStorage.setItem(GROUPBY_KEY, groupBy)
  }, [groupBy])

  // 顶部「等你」跳转：滚到第一个 waiting 分组/行
  useEffect(() => {
    if (scrollTo === 'waiting' && waitingRef.current) {
      waitingRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      onScrolled?.()
    }
  }, [scrollTo, groupBy, onScrolled])

  // 活跃集：current + waiting + deferred 合并（current 置顶）；done 单独折叠尾段
  const active = [
    ...(queue.current ? [{ ...queue.current, _seg: 'current' }] : []),
    ...queue.waiting.map((t) => ({ ...t, _seg: 'waiting' })),
    ...queue.deferred.map((t) => ({ ...t, _seg: 'deferred' })),
  ]
  const done = queue.done || []

  const groups =
    groupBy === 'none'
      ? [{ key: '__all__', label: null, items: active }]
      : groupTasks(active, groupBy)

  const empty = active.length === 0

  return (
    <div className="board">
      <div className="board-toolbar">
        <span className="board-toolbar-label">分组</span>
        {DIMENSIONS.map((d) => (
          <button
            key={d.key}
            className={`tab${groupBy === d.key ? ' active' : ''}`}
            onClick={() => setGroupBy(d.key)}
          >
            {d.label}
          </button>
        ))}
      </div>

      {empty ? (
        <div className="empty board-empty">
          <div className="empty-emoji">👑</div>
          <h2>没有在跑/等待的会话</h2>
          <p>会话完成或等待时会自动出现在这里</p>
        </div>
      ) : (
        groups.map((g) => {
          const isWaitingGroup =
            (groupBy === 'status' && g.key === 'waiting') ||
            (groupBy !== 'status' && g.items.some((t) => t.liveState === 'waiting'))
          return (
            <section
              key={g.key}
              className="board-group"
              ref={isWaitingGroup && !waitingRef.current ? waitingRef : null}
            >
              {g.label != null && (
                <div className="board-group-head">
                  <span className="bg-label">{g.label}</span>
                  <span className="bg-count">{g.items.length}</span>
                  {groupBy === 'project' && g.workingDir && (
                    <button
                      className="bg-new"
                      title={`在 ${g.workingDir} 开新会话`}
                      onClick={() => setOpenProj(openProj === g.key ? null : g.key)}
                    >
                      ＋ 新会话
                    </button>
                  )}
                </div>
              )}
              {openProj === g.key && g.workingDir && (
                <NewSessionInline
                  workingDir={g.workingDir}
                  api={api}
                  onDone={() => {
                    setOpenProj(null)
                    onAct(() => Promise.resolve())
                  }}
                  onCancel={() => setOpenProj(null)}
                />
              )}
              {g.items.map((t) => (
                <BoardRow
                  key={t.id}
                  t={t}
                  api={api}
                  onAct={onAct}
                  onReview={onReview}
                  deferDefault={deferDefault}
                  deferred={t._seg === 'deferred'}
                />
              ))}
            </section>
          )
        })
      )}

      {done.length > 0 && (
        <details className="board-done">
          <summary>✅ 今日已完成 ({done.length})</summary>
          {done
            .slice(-12)
            .reverse()
            .map((t) => (
              <div className="board-row done" key={t.id}>
                <span className="br-dot">✓</span>
                <span className="br-title" title={t.title}>
                  {t.title || '(无标题)'}
                </span>
                <span className="br-age">{age(t.completedAt)}</span>
              </div>
            ))}
        </details>
      )}
    </div>
  )
}
