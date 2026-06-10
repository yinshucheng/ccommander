import React, { useEffect, useRef, useState, useCallback } from 'react'
import { api, emitConverse } from './api.js'
import TaskCard from './TaskCard.jsx'
import Queue from './Queue.jsx'
import AddTask from './AddTask.jsx'
import Overview from './Overview.jsx'
import Settings from './Settings.jsx'

export default function App() {
  const [queue, setQueue] = useState({ current: null, waiting: [], deferred: [], done: [] })
  const [showQueue, setShowQueue] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showOverview, setShowOverview] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [connected, setConnected] = useState(false)
  const [procCount, setProcCount] = useState(0)
  const wsRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      setQueue(await api.queue())
    } catch (e) {
      /* server 可能还没起 */
    }
  }, [])

  // WebSocket 连接 + 自动重连
  useEffect(() => {
    let stop = false
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!stop) setTimeout(connect, 1500)
      }
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'queue_updated') setQueue(msg.queue)
        else if (msg.type === 'converse') emitConverse(msg)
      }
    }
    connect()
    return () => {
      stop = true
      wsRef.current?.close()
    }
  }, [])

  // 周期拉取「有几个 claude 在跑」
  useEffect(() => {
    const tick = () => api.stats().then((s) => setProcCount(s.claudeProcesses)).catch(() => {})
    tick()
    const t = setInterval(tick, 15000)
    return () => clearInterval(t)
  }, [])

  const current = queue.current

  const act = useCallback(
    async (fn) => {
      await fn()
      refresh()
    },
    [refresh]
  )

  // 全局快捷键
  useEffect(() => {
    function onKey(e) {
      if (showAdd || showSettings) return
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = e.key.toLowerCase()
      if (k === 'enter' && current) act(() => api.done(current.id))
      else if (k === 's' && current) act(() => api.skip(current.id))
      else if (k === 'l' && current) act(() => api.defer(current.id, 60))
      else if (k === 'd' && current) act(() => api.dismiss(current.id))
      else if (k === 'q') setShowQueue((v) => !v)
      else if (k === 'o') setShowOverview((v) => !v)
      else if (k === 'n') {
        e.preventDefault()
        setShowAdd(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, act, showAdd, showSettings])

  const waitingCount = queue.waiting.length
  const doneCount = queue.done.length

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-btn" onClick={() => setShowQueue((v) => !v)} title="队列 (Q)">
            ≡ 队列
          </button>
          <button className="icon-btn" onClick={() => setShowOverview((v) => !v)} title="全局视角 (O)">
            🌐 全局
          </button>
        </div>
        <div className="brand">Commander ⚡</div>
        <div className="conn">
          <span className={connected ? 'dot on' : 'dot off'} />
          <button className="icon-btn" onClick={() => setShowAdd(true)} title="新任务 (N)">
            + 新任务
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="设置">
            ⚙
          </button>
        </div>
      </header>

      <main className="stage">
        {current ? (
          <TaskCard key={current.id} task={current} onAct={act} api={api} />
        ) : (
          <div className="empty">
            <div className="empty-emoji">👑</div>
            <h2>没有待处理的任务</h2>
            <p>
              会话完成/等待时会自动出现，或按 <kbd>N</kbd> 添加，或在终端 <code>commander add "..."</code>
            </p>
          </div>
        )}
      </main>

      <footer className="statusbar">
        🔵 {procCount} 个 claude 在跑 &nbsp;|&nbsp; 待处理 {waitingCount + (current ? 1 : 0)} &nbsp;|&nbsp; 稍后{' '}
        {queue.deferred.length} &nbsp;|&nbsp; 今日已完成 {doneCount}
      </footer>

      {showQueue && <Queue queue={queue} onClose={() => setShowQueue(false)} />}
      {showOverview && <Overview onClose={() => setShowOverview(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {showAdd && (
        <AddTask
          onClose={() => setShowAdd(false)}
          onSubmit={async (data) => {
            await api.add(data)
            setShowAdd(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}
