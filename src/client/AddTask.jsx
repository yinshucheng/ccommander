import React, { useEffect, useRef, useState } from 'react'

export default function AddTask({ onClose, onSubmit }) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState('P2')
  const [type, setType] = useState('')
  const [context, setContext] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = (e) => {
    e.preventDefault()
    onSubmit({
      title: title.trim() || null,
      priority,
      type: type || null,
      context: context.trim() || null,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-title">新任务</div>
        <label className="field">
          <span>标题</span>
          <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可留空，后续补充" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>优先级</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option>P0</option>
              <option>P1</option>
              <option>P2</option>
              <option>P3</option>
            </select>
          </label>
          <label className="field">
            <span>类型</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">—</option>
              <option value="decision">decision</option>
              <option value="review">review</option>
              <option value="deep_work">deep_work</option>
              <option value="quick_action">quick_action</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>上下文</span>
          <textarea value={context} onChange={(e) => setContext(e.target.value)} rows={2} placeholder="5 秒内明白该干嘛的摘要" />
        </label>
        <div className="modal-actions">
          <button type="submit" className="act done">
            添加
          </button>
          <button type="button" className="act skip" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>
  )
}
