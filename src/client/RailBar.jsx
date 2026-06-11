import React from 'react'

// 窄左侧导航栏（~56px，活动栏式）：取代原顶部 bar。
// 承载跨 session 信息（视图切换 + 实时计数）与全局操作（新任务/设置/连接）。
// 默认收起只显图标；鼠标移上去横向展开显示文字+计数标签（浮层覆盖，不推主区）；
// 顶部图钉可把展开状态钉住（持久化，钉住时在布局流里占 200px，真正推开主区）。
// pinned/onTogglePin 由 App 持有，便于同步外层 .rail-slot 宽度（钉住才推主区）。
export default function RailBar({ view, setView, counts, connected, onAdd, onSettings, onCount, pinned, onTogglePin }) {
  return (
    <nav className={`railbar${pinned ? ' pinned' : ''}`}>
      <div className="rail-top">
        <span className="rail-logo" title="Commander ⚡">
          ⚡
        </span>
        <button
          className="rail-pin"
          onClick={onTogglePin}
          title={pinned ? '取消钉住（移开自动收起）' : '钉住展开'}
        >
          {pinned ? '《' : '》'}
        </button>
      </div>

      <div className="rail-group">
        <button
          className={`rail-btn${view === 'review' ? ' active' : ''}`}
          onClick={() => setView('review')}
          title="批阅当前任务 (B/Tab)"
        >
          <span className="rail-ico">📋</span>
          <span className="rail-label">批阅</span>
        </button>
        <button
          className={`rail-btn${view === 'board' ? ' active' : ''}`}
          onClick={() => setView('board')}
          title="面板：所有会话分组速览 (B/Tab)"
        >
          <span className="rail-ico">🗂</span>
          <span className="rail-label">面板</span>
        </button>
      </div>

      <div className="rail-counts">
        <button
          className="rail-count waiting"
          onClick={() => onCount('waiting')}
          title={`${counts.waiting} 个会话可能在等你`}
        >
          <span className="rc-dot" />
          <span className="rc-n">{counts.waiting}</span>
          <span className="rail-label">等你</span>
        </button>
        <button
          className="rail-count running"
          onClick={() => onCount()}
          title={`${counts.running} 个会话在跑`}
        >
          <span className="rc-dot" />
          <span className="rc-n">{counts.running}</span>
          <span className="rail-label">在跑</span>
        </button>
        <button
          className="rail-count idle"
          onClick={() => onCount()}
          title={`${counts.idle} 个会话静默`}
        >
          <span className="rc-dot" />
          <span className="rc-n">{counts.idle}</span>
          <span className="rail-label">静默</span>
        </button>
      </div>

      <div className="rail-spacer" />

      <div className="rail-bottom">
        <button className="rail-btn" onClick={onAdd} title="新任务 (N)">
          <span className="rail-ico">＋</span>
          <span className="rail-label">新任务</span>
        </button>
        <button className="rail-btn" onClick={onSettings} title="设置">
          <span className="rail-ico">⚙</span>
          <span className="rail-label">设置</span>
        </button>
        <div className="rail-btn rail-conn-row" title={connected ? '已连接' : '未连接'}>
          <span className={`rail-ico rail-conn ${connected ? 'on' : 'off'}`} />
          <span className="rail-label">{connected ? '已连接' : '未连接'}</span>
        </div>
      </div>
    </nav>
  )
}
