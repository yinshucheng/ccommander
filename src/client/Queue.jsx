import React from 'react'

function age(ts) {
  if (!ts) return ''
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 60) return `${m}m`
  return `${(m / 60).toFixed(1)}h`
}

function deferLeft(ts) {
  const m = Math.ceil((ts - Date.now()) / 60000)
  return m > 0 ? `${m}min后` : '即将'
}

const DOT = { P0: '🔴', P1: '🟡', P2: '🟢', P3: '🔵' }

function Row({ t, suffix }) {
  return (
    <div className="q-row">
      <span className="q-dot">{DOT[t.priority]}</span>
      <span className="q-title">{t.title || '(无标题)'}</span>
      <span className="q-age">{suffix}</span>
    </div>
  )
}

export default function Queue({ queue, onClose }) {
  const total = (queue.current ? 1 : 0) + queue.waiting.length
  return (
    <div className="queue-overlay" onClick={onClose}>
      <aside className="queue-panel" onClick={(e) => e.stopPropagation()}>
        <div className="q-head">
          📋 队列 ({total})
          <button className="q-close" onClick={onClose}>
            ×
          </button>
        </div>

        {queue.current && (
          <>
            <div className="q-section">→ 当前</div>
            <Row t={queue.current} suffix={age(queue.current.queuedAt)} />
          </>
        )}

        {queue.waiting.length > 0 && (
          <>
            <div className="q-section">等待中</div>
            {queue.waiting.map((t) => (
              <Row key={t.id} t={t} suffix={age(t.queuedAt)} />
            ))}
          </>
        )}

        {queue.deferred.length > 0 && (
          <>
            <div className="q-section">⏰ 稍后 ({queue.deferred.length})</div>
            {queue.deferred.map((t) => (
              <Row key={t.id} t={t} suffix={deferLeft(t.deferUntil)} />
            ))}
          </>
        )}

        {queue.done.length > 0 && (
          <>
            <div className="q-section">✅ 已完成 ({queue.done.length})</div>
            {queue.done.slice(-8).reverse().map((t) => (
              <Row key={t.id} t={t} suffix={age(t.completedAt)} />
            ))}
          </>
        )}
      </aside>
    </div>
  )
}
