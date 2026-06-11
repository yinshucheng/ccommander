import React, { useState } from 'react'
import { toolSummary } from './view-mode.js'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/github-dark.css'
import { diffLines } from 'diff'

// 只注册常用语言，避免全量包过大
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import markdownLang from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('markdown', markdownLang)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('sql', sql)

marked.setOptions({ breaks: true, gfm: true })

function sanitize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/ on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
}

// 文件后缀 → hljs 语言
const EXT_LANG = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', css: 'css', scss: 'css', html: 'html', xml: 'xml',
  go: 'go', rs: 'rust', md: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql',
}
function langForFile(path = '') {
  const ext = path.split('.').pop()?.toLowerCase()
  return EXT_LANG[ext] || null
}
function highlight(code, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function fileName(path = '') {
  return path.split('/').slice(-2).join('/') || path
}

export function Markdown({ text }) {
  let html = ''
  try {
    html = sanitize(marked.parse(text || ''))
  } catch {
    html = escapeHtml(text || '')
  }
  return <div className="ctx-text md" dangerouslySetInnerHTML={{ __html: html }} />
}

// ── 折叠容器 ──
function Collapsible({ icon, title, sub, defaultOpen = false, accent, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`part-card${accent ? ` ${accent}` : ''}`}>
      <button className="part-head" onClick={() => setOpen((o) => !o)}>
        <span className="part-caret">{open ? '▾' : '▸'}</span>
        <span className="part-icon">{icon}</span>
        <span className="part-title">{title}</span>
        {sub && <span className="part-sub">{sub}</span>}
      </button>
      {open && <div className="part-body">{children}</div>}
    </div>
  )
}

function CodeBlock({ code, lang }) {
  const html = highlight(code, lang)
  return (
    <pre className="code-block hljs">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

// ── Edit / Write：diff 视图 ──
function DiffPart({ part }) {
  const { input, result } = part
  const path = input.file_path || ''
  const isWrite = part.name === 'Write'
  const isError = result?.isError

  let bodyEl
  if (isWrite) {
    bodyEl = <CodeBlock code={input.content || ''} lang={langForFile(path)} />
  } else {
    const changes = diffLines(input.old_string || '', input.new_string || '')
    bodyEl = (
      <pre className="diff-block">
        {changes.map((c, i) => {
          const cls = c.added ? 'add' : c.removed ? 'del' : 'ctx'
          const sign = c.added ? '+' : c.removed ? '-' : ' '
          // 上下文行过多则省略中间
          const lines = c.value.replace(/\n$/, '').split('\n')
          return lines.map((ln, j) => (
            <div key={`${i}-${j}`} className={`diff-line ${cls}`}>
              <span className="diff-sign">{sign}</span>
              <span className="diff-text">{ln || ' '}</span>
            </div>
          ))
        })}
      </pre>
    )
  }

  return (
    <Collapsible
      icon={isWrite ? '📝' : '✏️'}
      title={isWrite ? '写入' : '编辑'}
      sub={fileName(path)}
      defaultOpen
      accent={isError ? 'err' : ''}
    >
      {bodyEl}
      {result?.text && isError && <div className="part-result-err">{result.text}</div>}
    </Collapsible>
  )
}

// ── Bash：命令 + 输出 ──
function BashPart({ part }) {
  const { input, result } = part
  return (
    <Collapsible
      icon="❯"
      title="Bash"
      sub={input.description || ''}
      defaultOpen
      accent={result?.isError ? 'err' : ''}
    >
      <pre className="code-block hljs">
        <code dangerouslySetInnerHTML={{ __html: highlight(input.command || '', 'bash') }} />
      </pre>
      {result?.text && (
        <details className="bash-output">
          <summary>输出{result.isError ? '（出错）' : ''}</summary>
          <pre className="output-block">{result.text}</pre>
        </details>
      )}
    </Collapsible>
  )
}

// ── Read/Grep/Glob/LS：折叠块 ──
const FILE_TOOL_META = {
  Read: { icon: '📄', verb: '读取', key: 'file_path' },
  Grep: { icon: '🔍', verb: '搜索', key: 'pattern' },
  Glob: { icon: '🗂️', verb: '匹配', key: 'pattern' },
  LS: { icon: '📁', verb: '列目录', key: 'path' },
}
function FilePart({ part }) {
  const meta = FILE_TOOL_META[part.name]
  const arg = part.input[meta.key] || ''
  const sub = meta.key === 'file_path' || meta.key === 'path' ? fileName(arg) : arg
  return (
    <Collapsible icon={meta.icon} title={meta.verb} sub={sub} accent={part.result?.isError ? 'err' : ''}>
      {part.result?.text ? (
        <pre className="output-block">{part.result.text}</pre>
      ) : (
        <div className="part-empty">（无输出）</div>
      )}
    </Collapsible>
  )
}

// ── 思考块 ──
function ThinkingPart({ part }) {
  return (
    <Collapsible icon="💭" title="思考">
      <div className="thinking-text">{part.text}</div>
    </Collapsible>
  )
}

// ── TodoWrite 清单 ──
const TODO_MARK = { completed: '✓', in_progress: '◐', pending: '○' }
function TodoPart({ part }) {
  return (
    <div className="part-card todo">
      <div className="todo-head">📋 任务清单</div>
      <ul className="todo-list">
        {part.items.map((t, i) => (
          <li key={i} className={`todo-item ${t.status}`}>
            <span className="todo-mark">{TODO_MARK[t.status] || '○'}</span>
            <span className="todo-content">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── 兜底：其它工具 ──
function GenericToolPart({ part }) {
  const summary = Object.entries(part.input)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)}`)
    .join('  ')
  return (
    <Collapsible icon="🔧" title={part.name} sub={summary} accent={part.result?.isError ? 'err' : ''}>
      <pre className="output-block">{JSON.stringify(part.input, null, 2)}</pre>
      {part.result?.text && <pre className="output-block">{part.result.text}</pre>}
    </Collapsible>
  )
}

// ── 分发器 ──
function ToolPart({ part }) {
  if (part.name === 'Edit' || part.name === 'Write') return <DiffPart part={part} />
  if (part.name === 'Bash') return <BashPart part={part} />
  if (FILE_TOOL_META[part.name]) return <FilePart part={part} />
  return <GenericToolPart part={part} />
}

// ── 单行折叠（Digest 档）：thinking / tool_use 收成一行，点击就地展开完整 MessagePart ──
export function CollapsedPart({ part }) {
  const [open, setOpen] = useState(false)
  if (open) return <MessagePart part={part} />
  const isThinking = part.kind === 'thinking'
  const label = isThinking ? '💭 思考' : toolSummary(part)
  const isErr = !isThinking && part.result?.isError
  return (
    <button className={`collapsed-line${isErr ? ' err' : ''}`} onClick={() => setOpen(true)} title="点击展开">
      <span className="collapsed-caret">▸</span>
      <span className="collapsed-label">{label}</span>
    </button>
  )
}

export function MessagePart({ part }) {
  switch (part.kind) {
    case 'text':
      return <Markdown text={part.text} />
    case 'thinking':
      return <ThinkingPart part={part} />
    case 'tool_use':
      return <ToolPart part={part} />
    case 'todos':
      return <TodoPart part={part} />
    case 'tool_result':
      // 通常已被 tool_use 吸收；孤立的结果兜底显示
      return <pre className="output-block">{part.text}</pre>
    default:
      return null
  }
}
