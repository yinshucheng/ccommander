import React, { useEffect, useState } from 'react'
import { api } from './api.js'

function dur(ms) {
  if (ms == null) return '—'
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}min`
  const h = m / 60
  if (h < 24) return `${h.toFixed(1)}h`
  return `${Math.floor(h / 24)}d`
}

const STATE_META = {
  waiting: { dot: '🟡', label: '可能在等你' },
  running: { dot: '🔵', label: '在跑' },
  idle: { dot: '⚪', label: '静默' },
  completed: { dot: '✓', label: '已完成' },
}

export default function Overview({ onClose }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    const tick = () => api.overview().then(setData).catch(() => {})
    tick()
    const t = setInterval(tick, 10000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="queue-overlay" onClick={onClose}>
      <aside className="queue-panel overview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="q-head">
          <span>全局视角</span>
          <button className="q-close" onClick={onClose}>
            ×
          </button>
        </div>

        {!data ? (
          <div className="ctx-loading">加载中…</div>
        ) : (
          <>
            <div className="ov-stats">
              <div className="ov-total">
                <span className="ov-num">{data.total}</span>
                <span className="ov-num-label">个会话</span>
              </div>
              <div className="ov-states">
                {Object.entries(data.byState).map(([k, v]) =>
                  v > 0 ? (
                    <div key={k} className="ov-state">
                      <span className="ov-state-dot">{STATE_META[k]?.dot || '•'}</span>
                      <span className="ov-state-n">{v}</span>
                      <span className="ov-state-l">{STATE_META[k]?.label || k}</span>
                    </div>
                  ) : null
                )}
              </div>
            </div>

            {data.waitingLongest?.length > 0 && (
              <div className="ov-section">
                <div className="ov-section-head">🟡 等你最久的</div>
                {data.waitingLongest.map((w) => (
                  <div key={w.claudeSessionId} className="ov-row">
                    <span className="ov-row-proj">📁 {w.projectName || '?'}</span>
                    <span className="ov-row-label">{(w.label || '(无标题)').slice(0, 28)}</span>
                    <span className="ov-row-dur">{dur(w.idleMs)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="ov-section">
              <div className="ov-section-head">⏳ 最久没动静</div>
              {data.stalest?.map((w) => (
                <div key={w.claudeSessionId} className="ov-row">
                  <span className="ov-row-proj">
                    {STATE_META[w.liveState]?.dot} {w.projectName || '?'}
                  </span>
                  <span className="ov-row-label">{(w.label || '(无标题)').slice(0, 28)}</span>
                  <span className="ov-row-dur">{dur(w.idleMs)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
