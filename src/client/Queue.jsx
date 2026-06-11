import React from 'react'

function age(ts) {
  if (!ts) return ''
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 60) return `${m}m`
  return `${(m / 60).toFixed(1)}h`
}

function deferLeft(ts) {
  const m = Math.ceil((ts - Date.now()) / 60000)
  if (m <= 0) return '即将'
  if (m < 60) return `${m}min后`
  return `${(m / 60).toFixed(1)}h后`
}

const DOT = { P0: '🔴', P1: '🟡', P2: '🟢', P3: '🔵' }

function Row({ t, suffix, actions }) {
  return (
    <div className="q-row">
      <span className="q-dot">{DOT[t.priority]}</span>
      <span className="q-title">{t.title || '(无标题)'}</span>
      {t.skipCount > 0 && <span className="q-skip" title="被跳过次数">↻{t.skipCount}</span>}
      <span className="q-age">{suffix}</span>
      {actions}
    </div>
  )
}

export default function Queue({ queue, api, onAct, onClose }) {
  const total = (queue.current ? 1 : 0) + queue.waiting.length
  // 提前唤回 / 直接完成：复用 App 的 act（含 refresh）；无 api 时降级为只读
  const act = onAct || ((fn) => fn())
  const undefer = (id) => api && act(() => api.undefer(id))
  const done = (id) => api && act(() => api.done(id))

  return (
    <div className="queue-overlay" onClick={onClose}>
      <aside className="queue-panel" onClick={(e) => e.stopPropagation()}>
        <div className="q-head">
          📋 队列 ({total})
          <button className="q-close" onClick={onClose}>
            ×
          </button>
        </div>

        {queue.skippedTotal > 0 && (
          <div className="q-skipsum">
            ↻ 队列中累计跳过 {queue.skippedTotal} 次（{queue.skippedTasks} 个任务）
          </div>
        )}

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
              <Row
                key={t.id}
                t={t}
                suffix={deferLeft(t.deferUntil)}
                actions={
                  api && (
                    <span className="q-acts">
                      <button className="q-act" title="提前唤回到队列" onClick={() => undefer(t.id)}>
                        ↑唤回
                      </button>
                      <button className="q-act" title="直接标记完成" onClick={() => done(t.id)}>
                        ✓完成
                      </button>
                    </span>
                  )
                }
              />
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
