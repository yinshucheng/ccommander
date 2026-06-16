import React, { useEffect, useRef, useState, useCallback } from 'react'
import { api, emitConverse } from './api.js'
import TaskCard from './TaskCard.jsx'
import Board from './Board.jsx'
import AddTask from './AddTask.jsx'
import Settings from './Settings.jsx'
import RailBar from './RailBar.jsx'
import { countByState } from './board-group.js'
import { resolveCurrent, selectedExists } from './review-select.js'

const VIEW_KEY = 'commander.view'
const PIN_KEY = 'commander.railPinned'

export default function App() {
  const [queue, setQueue] = useState({ current: null, waiting: [], deferred: [], done: [] })
  const [view, setView] = useState(() => localStorage.getItem(VIEW_KEY) || 'review')
  const [railPinned, setRailPinned] = useState(() => localStorage.getItem(PIN_KEY) === '1')
  const [boardScrollTo, setBoardScrollTo] = useState(null)
  // 批阅视图里被「钉住」的 task：从面板点「批阅」跳转时设；为 null 则跟随队列头部 current。
  const [selectedId, setSelectedId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [connected, setConnected] = useState(false)
  const [deferDefault, setDeferDefault] = useState(30)
  const wsRef = useRef(null)

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
  }, [view])

  const refresh = useCallback(async () => {
    try {
      setQueue(await api.queue())
    } catch (e) {
      /* server 可能还没起 */
    }
  }, [])

  const loadConfig = useCallback(() => {
    api
      .getConfig()
      .then((c) => setDeferDefault(Number(c?.deferDefaultMinutes) || 30))
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

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
        // 权限审批/澄清/计划请求与落定：复用 converse 的 pub/sub（带 sid，TaskCard 自行过滤）
        else if (msg.type === 'permission_request' || msg.type === 'permission_resolved')
          emitConverse(msg)
        // 第 3/4/5 项：thinking / sid 迁移（compact/fork）/ 进程死亡 / 重启
        // A-1：turn-aborted (ESC 中断本轮)
        else if (
          msg.type === 'thinking' ||
          msg.type === 'session-died' ||
          msg.type === 'session-migrated' ||
          msg.type === 'session-restarted' ||
          msg.type === 'session_aliased' ||
          msg.type === 'turn-aborted'
        ) {
          emitConverse(msg)
        }
      }
    }
    connect()
    return () => {
      stop = true
      wsRef.current?.close()
    }
  }, [])

  // 批阅视图显示的 task：钉住了就显示钉住的，否则回落到队列头部 current（见 review-select.js）
  const current = resolveCurrent(queue, selectedId)

  // 钉住的 task 已不在活跃队列里(被完成/移除) → 自动解除钉住，回到跟随 current
  useEffect(() => {
    if (selectedId != null && !selectedExists(queue, selectedId)) setSelectedId(null)
  }, [selectedId, queue])

  // 批阅动作反馈:刚生效的动作 → 一条带撤销窗口的 toast。
  // { kind: 'done'|'skip'|'defer'|'dismiss', title, undo?: () => Promise }
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)
  const dismissToast = useCallback(() => {
    clearTimeout(toastTimer.current)
    setToast((t) => (t ? { ...t, leaving: true } : null))
    setTimeout(() => setToast(null), 160) // 与 toast-out 时长对齐
  }, [])

  const act = useCallback(
    async (fn, meta) => {
      // fn 可返回 { mergeMeta } 让动作执行后追加额外字段到 toast meta —— 主要给
      // skip 用：skip 需要把响应里的 _prev 包成 undo 回调挂到 toast 上。撤销窗口 4s。
      const extra = (await fn()) || {}
      // MANIFESTO §五「一道朱批，下一份自动呈上」/ PRODUCT「下一条流畅呈上」：
      // 批阅视图里的批阅动作（done/skip/defer/dismiss）一旦发出，就意味着用户对
      // 当前这条的专注结束 —— 立刻解除钉住，让 resolveCurrent 回落到 queue.current
      // = 经过 rerank 后的真·队列头部 = 下一条。
      //
      // 注：done/defer/dismiss 让 task 离开活跃队列，原本就会被下方 useEffect 自动清；
      // 但 skip 让 task 留在队列（只是重排到同档末尾），useEffect 不会触发 —— 那条专门
      // bug。统一在动作完成时主动清掉，避免再写一条规则。
      if (meta && ['done', 'skip', 'defer', 'dismiss'].includes(meta.kind)) {
        setSelectedId(null)
      }
      refresh()
      if (meta) {
        clearTimeout(toastTimer.current)
        setToast({ ...meta, ...extra, leaving: false })
        toastTimer.current = setTimeout(dismissToast, 4000) // 撤销窗口 4s
      }
    },
    [refresh, dismissToast]
  )

  // 全局快捷键
  useEffect(() => {
    function onKey(e) {
      if (showAdd || showSettings) return
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = e.key.toLowerCase()
      const t = current?.title || '(未命名任务)'
      // 视图切换：b / Tab 在 批阅 ↔ 面板 间切换
      if (k === 'b' || k === 'tab') {
        e.preventDefault()
        setView((v) => (v === 'review' ? 'board' : 'review'))
        return
      }
      if (k === 'n') {
        e.preventDefault()
        setShowAdd(true)
        return
      }
      // 批阅快捷键仅在「批阅」视图生效（面板视图用行内按钮操作）
      if (view !== 'review' || !current) return
      if (k === 'enter') act(() => api.done(current.id), { kind: 'done', title: t })
      else if (k === 's') {
        // skip 返回响应里带 _prev 快照 → 包成 undo 回调挂到 toast 上，4s 内点撤销可回滚。
        const id = current.id
        act(
          () => api.skip(id).then((r) => ({ undo: () => api.unskip(id, r?._prev) })),
          { kind: 'skip', title: t }
        )
      }
      else if (k === 'l') act(() => api.defer(current.id, deferDefault), { kind: 'defer', title: t })
      else if (k === 'd') act(() => api.dismiss(current.id), { kind: 'dismiss', title: t })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, act, showAdd, showSettings, deferDefault, view])

  // 左栏实时计数：从 current + waiting + deferred 的 task liveState 聚合（口径与面板一致）
  const counts = countByState([
    ...(queue.current ? [queue.current] : []),
    ...queue.waiting,
    ...queue.deferred,
  ])

  const goBoard = (scrollTo) => {
    setView('board')
    if (scrollTo) {
      setBoardScrollTo(scrollTo)
      // 让 Board 的 effect 跑一轮后清掉，避免重切视图时反复滚动
      setTimeout(() => setBoardScrollTo(null), 600)
    }
  }

  // 从面板某行「批阅」跳转：钉住该 task 并切到批阅视图
  const goReview = (taskId) => {
    setSelectedId(taskId)
    setView('review')
  }

  const TOAST_LABEL = { done: '已完成', skip: '已跳过', defer: '已稍后', dismiss: '已移除' }
  const TOAST_ICON = { done: '✓', skip: '→', defer: '⏰', dismiss: '✕' }

  return (
    <div className="app">
      <div className={`rail-slot${railPinned ? ' pinned' : ''}`}>
        <RailBar
          view={view}
          setView={setView}
          counts={counts}
          connected={connected}
          onAdd={() => setShowAdd(true)}
          onSettings={() => setShowSettings(true)}
          onCount={goBoard}
          pinned={railPinned}
          onTogglePin={() => {
            setRailPinned((p) => {
              const next = !p
              localStorage.setItem(PIN_KEY, next ? '1' : '0')
              return next
            })
          }}
        />
      </div>

      <div className="app-main">
        {view === 'board' ? (
          <main className="stage board-mode">
            <Board
              queue={queue}
              api={api}
              onAct={act}
              onReview={goReview}
              deferDefault={deferDefault}
              scrollTo={boardScrollTo}
              onScrolled={() => setBoardScrollTo(null)}
            />
          </main>
        ) : (
          <main className="stage">
            {current ? (
              <div key={current.id} className="task-enter" style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
                <TaskCard task={current} onAct={act} api={api} deferDefault={deferDefault} />
              </div>
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
        )}
      </div>

      {toast && (
        <div className={`act-toast${toast.leaving ? ' leaving' : ''}`} role="status" aria-live="polite">
          <span className={`act-toast-icon ${toast.kind}`}>{TOAST_ICON[toast.kind]}</span>
          <span className="act-toast-text">
            <b>{toast.title}</b> {TOAST_LABEL[toast.kind] || ''}
          </span>
          <button
            className="act-toast-undo"
            onClick={() => {
              if (!toast.undo) return
              act(toast.undo)
              dismissToast()
            }}
            disabled={!toast.undo}
            title={toast.undo ? '撤销这一步' : '撤销即将支持'}
          >
            撤销
          </button>
        </div>
      )}

      {showSettings && (
        <Settings
          onClose={() => {
            setShowSettings(false)
            loadConfig()
          }}
        />
      )}
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
