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
// selectMode: 聚焦选择模式下——行左侧显示勾选框，点整行即切换选中（不触发批阅/操作）。
function BoardRow({ t, api, onAct, onReview, deferDefault, deferred, selectMode, selected, onToggleSelect }) {
  const proj = (t.sessionDetails || [])[0]
  const projName = proj?.projectName
  const branch = proj?.gitBranch
  const sub = [projName, branch].filter(Boolean).join(' · ')
  const meta = { title: t.title || '(未命名任务)' }

  return (
    <div
      className={`board-row${selectMode ? ' selectable' : ''}${selected ? ' selected' : ''}`}
      onClick={selectMode ? () => onToggleSelect(t.id) : undefined}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="br-check"
          checked={selected}
          readOnly
          tabIndex={-1}
        />
      )}
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
      {!selectMode && (
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
      )}
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

const FOCUS_DURATIONS = [
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '4h', minutes: 240 },
]

export default function Board({ queue, api, onAct, onReview, deferDefault = 30, scrollTo, onScrolled }) {
  const [groupBy, setGroupBy] = useState(
    () => localStorage.getItem(GROUPBY_KEY) || 'project'
  )
  // 当前展开「＋ 新会话」输入的分组 key（同时只开一个）
  const [openProj, setOpenProj] = useState(null)
  // 聚焦选择模式（spec 017）：进入后行可勾选，选完设 focus 窗口
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [minutes, setMinutes] = useState(120)
  const [focusing, setFocusing] = useState(false)
  const waitingRef = useRef(null)

  const toggleSelect = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }
  const startFocus = async () => {
    if (selected.size === 0 || focusing) return
    setFocusing(true)
    try {
      await onAct(() => api.setFocus([...selected], minutes))
      exitSelect()
    } finally {
      setFocusing(false)
    }
  }

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
        <span className="board-toolbar-spacer" />
        {selectMode ? (
          <button className="tab" onClick={exitSelect}>
            取消选择
          </button>
        ) : (
          <button
            className="tab focus-enter"
            title="进入选择模式：勾选一批任务，设一段时间只调度它们"
            onClick={() => setSelectMode(true)}
          >
            🎯 聚焦
          </button>
        )}
      </div>

      {selectMode && (
        <div className="focus-bar">
          <span className="focus-bar-count">已选 {selected.size} 个</span>
          <span className="focus-bar-durs">
            {FOCUS_DURATIONS.map((d) => (
              <button
                key={d.minutes}
                className={`tab${minutes === d.minutes ? ' active' : ''}`}
                onClick={() => setMinutes(d.minutes)}
              >
                {d.label}
              </button>
            ))}
          </span>
          <button
            className="tab focus-go"
            disabled={selected.size === 0 || focusing}
            onClick={startFocus}
          >
            {focusing ? '设置中…' : `🎯 聚焦这 ${selected.size} 个`}
          </button>
        </div>
      )}

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
                  {selectMode ? (
                    <button
                      className="bg-new"
                      title="整选/取消本组"
                      onClick={() => {
                        const ids = g.items.map((t) => t.id)
                        const allSel = ids.every((id) => selected.has(id))
                        setSelected((prev) => {
                          const next = new Set(prev)
                          ids.forEach((id) => (allSel ? next.delete(id) : next.add(id)))
                          return next
                        })
                      }}
                    >
                      {g.items.every((t) => selected.has(t.id)) ? '取消本组' : '整选本组'}
                    </button>
                  ) : (
                    groupBy === 'project' && g.workingDir && (
                      <button
                        className="bg-new"
                        title={`在 ${g.workingDir} 开新会话`}
                        onClick={() => setOpenProj(openProj === g.key ? null : g.key)}
                      >
                        ＋ 新会话
                      </button>
                    )
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
                  selectMode={selectMode}
                  selected={selected.has(t.id)}
                  onToggleSelect={toggleSelect}
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
