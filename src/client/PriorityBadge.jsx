import React, { useEffect, useRef, useState } from 'react'

const PRIORITY_CLASS = { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3' }
const LEVELS = ['P0', 'P1', 'P2', 'P3']
// P0 = 硬置顶（scheduler.rank 里 P0 始终排最前，无视 liveState）
const HINT = { P0: '置顶', P1: '高', P2: '中', P3: '低' }

// 可点的优先级 badge：点开四档下拉，选中即 PATCH /api/tasks/:id {priority}。
// onChanged(id, priority) 由调用方负责触发刷新（Board 走 onAct、TaskCard 走 onAct）。
export default function PriorityBadge({ task, api, onChanged, title }) {
  const cur = task.priority || 'P2'
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  // 点浮层外部 / 按 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function pick(p, e) {
    e.stopPropagation()
    setOpen(false)
    if (p === cur || busy) return
    setBusy(true)
    try {
      await onChanged(task.id, p)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="prio-badge-wrap" ref={ref}>
      <button
        type="button"
        className={`badge ${PRIORITY_CLASS[cur] || 'p2'} prio-badge-btn`}
        title={title || '点击改优先级（P0 置顶）'}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {cur}
      </button>
      {open && (
        <div className="prio-menu" role="listbox">
          {LEVELS.map((p) => (
            <button
              type="button"
              key={p}
              role="option"
              aria-selected={p === cur}
              className={`prio-menu-item ${PRIORITY_CLASS[p]}${p === cur ? ' active' : ''}`}
              onClick={(e) => pick(p, e)}
            >
              <span className={`badge ${PRIORITY_CLASS[p]}`}>{p}</span>
              <span className="prio-menu-hint">{HINT[p]}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
