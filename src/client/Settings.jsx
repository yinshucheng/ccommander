import React, { useEffect, useState } from 'react'
import { api } from './api.js'

export default function Settings({ onClose }) {
  const [cfg, setCfg] = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.getConfig().then(setCfg).catch(() => setCfg({}))
  }, [])

  const save = async () => {
    await api.patchConfig({
      cmdTemplate: cfg.cmdTemplate,
      contextRecentCount: Number(cfg.contextRecentCount) || 5,
      analyzeProvider: cfg.analyzeProvider,
      analyzeBaseUrl: cfg.analyzeBaseUrl,
      analyzeApiKey: cfg.analyzeApiKey,
      analyzeModel: cfg.analyzeModel,
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  if (!cfg) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">设置</div>

        <label className="field">
          <span>启动会话命令模板</span>
          <input
            className="mono"
            value={cfg.cmdTemplate || ''}
            onChange={(e) => setCfg({ ...cfg, cmdTemplate: e.target.value })}
          />
          <span className="field-hint">
            占位符 <code>{'{sessionId}'}</code> <code>{'{workingDir}'}</code>。改后对新发现的会话生效。
          </span>
        </label>

        <label className="field">
          <span>上下文展示「最近几条」</span>
          <input
            type="number"
            min="1"
            max="30"
            value={cfg.contextRecentCount ?? 5}
            onChange={(e) => setCfg({ ...cfg, contextRecentCount: e.target.value })}
          />
        </label>

        <div className="settings-divider">LLM 分析进展</div>

        <label className="field">
          <span>分析 Provider</span>
          <select
            value={cfg.analyzeProvider || 'none'}
            onChange={(e) => setCfg({ ...cfg, analyzeProvider: e.target.value })}
          >
            <option value="none">none（规则粗判，不联网）</option>
            <option value="openai-compatible">openai-compatible（真模型）</option>
          </select>
        </label>

        {cfg.analyzeProvider === 'openai-compatible' && (
          <>
            <label className="field">
              <span>Base URL</span>
              <input
                className="mono"
                value={cfg.analyzeBaseUrl || ''}
                onChange={(e) => setCfg({ ...cfg, analyzeBaseUrl: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Model</span>
              <input
                className="mono"
                value={cfg.analyzeModel || ''}
                onChange={(e) => setCfg({ ...cfg, analyzeModel: e.target.value })}
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                className="mono"
                value={cfg.analyzeApiKey || ''}
                onChange={(e) => setCfg({ ...cfg, analyzeApiKey: e.target.value })}
              />
              <span className="field-hint">仅存在本机 ~/.commander/config.json，与其他项目解耦。</span>
            </label>
          </>
        )}

        <div className="modal-actions">
          <button className="act done" onClick={save}>
            {saved ? '✓ 已保存' : '保存'}
          </button>
          <button className="act" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
