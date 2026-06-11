#!/usr/bin/env node
import { startServer } from '../src/server/index.js'
import { installHooks, uninstallHooks } from '../src/server/install-hooks.js'

const PORT = process.env.COMMANDER_PORT || 3890
const BASE = `http://localhost:${PORT}`

const PRIORITY_FLAGS = { '-p0': 'P0', '-p1': 'P1', '-p2': 'P2', '-p3': 'P3' }

function parseArgs(argv) {
  // 提取 title（第一个非 flag 的位置参数）+ 选项
  const opts = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a in PRIORITY_FLAGS) {
      opts.priority = PRIORITY_FLAGS[a]
    } else if (a === '-p' || a === '--priority') {
      opts.priority = argv[++i]
    } else if (a === '-t' || a === '--type') {
      opts.type = argv[++i]
    } else if (a === '-c' || a === '--context') {
      opts.context = argv[++i]
    } else if (a === '--session-id') {
      opts.sessionId = argv[++i]
    } else if (a === '--cwd') {
      opts.workingDir = argv[++i]
    } else if (a === '--cmd' || a === '--command') {
      opts.command = argv[++i]
    } else if (a === '--agent') {
      opts.agentType = argv[++i]
    } else if (a === '--label') {
      opts.sessionLabel = argv[++i]
    } else if (a.startsWith('-')) {
      console.error(`未知选项: ${a}`)
    } else {
      positionals.push(a)
    }
  }
  return { opts, positionals }
}

async function api(path, method = 'GET', body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e) {
    console.error(`✗ 无法连接 Commander server (${BASE})。先运行 \`commander serve\`。`)
    console.error(`  (${e.message})`)
    process.exit(1)
  }
}

function fmtPriority(p) {
  const dot = { P0: '🔴', P1: '🟡', P2: '🟢', P3: '🔵' }[p] || '⚪'
  return `${dot} ${p}`
}

function fmtAge(ts) {
  if (!ts) return ''
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 60) return `${m}m`
  return `${(m / 60).toFixed(1)}h`
}

const [cmd, ...rest] = process.argv.slice(2)

switch (cmd) {
  case 'serve': {
    const pIdx = rest.indexOf('--port')
    const port = pIdx >= 0 ? Number(rest[pIdx + 1]) : Number(PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`✗ 端口非法: '${pIdx >= 0 ? rest[pIdx + 1] : PORT}'（需 1..65535 的整数）`)
      process.exit(1)
    }
    startServer({ port })
    break
  }

  case 'add': {
    const { opts, positionals } = parseArgs(rest)
    const title = positionals.join(' ') || null
    const task = await api('/api/tasks', 'POST', { ...opts, title })
    console.log(`✓ 已添加任务 ${task.id} ${fmtPriority(task.priority)} ${task.title || '(无标题)'}`)
    break
  }

  case 'list': {
    const q = await api('/api/queue')
    const line = (t, mark = '  ') =>
      `${mark}${fmtPriority(t.priority)}  ${(t.title || '(无标题)').padEnd(24)} ${fmtAge(t.queuedAt).padStart(5)}  ${t.id}`
    if (q.current) {
      console.log('\n→ 当前')
      console.log(line(q.current, '  '))
    }
    if (q.waiting.length) {
      console.log('\n  等待中')
      q.waiting.forEach((t) => console.log(line(t)))
    }
    if (q.deferred.length) {
      console.log('\n⏰ 稍后')
      q.deferred.forEach((t) => console.log(line(t)))
    }
    if (q.done.length) {
      console.log(`\n✅ 已完成 (${q.done.length})`)
    }
    console.log('')
    break
  }

  case 'done': {
    let id = rest[0]
    if (!id) {
      const { task } = await api('/api/current')
      if (!task) {
        console.log('没有当前任务。')
        break
      }
      id = task.id
    }
    const t = await api(`/api/tasks/${id}/done`, 'POST')
    console.log(`✓ 完成 ${t.title || t.id}`)
    break
  }

  case 'skip': {
    const { task } = rest[0] ? { task: { id: rest[0] } } : await api('/api/current')
    if (!task) {
      console.log('没有当前任务。')
      break
    }
    await api(`/api/tasks/${task.id}/skip`, 'POST')
    console.log(`→ 已跳过 ${task.id}`)
    break
  }

  case 'defer': {
    const { task } = rest[0] ? { task: { id: rest[0] } } : await api('/api/current')
    const minutes = Number(rest[1]) || 60
    if (!task) {
      console.log('没有当前任务。')
      break
    }
    await api(`/api/tasks/${task.id}/defer`, 'POST', { minutes })
    console.log(`⏰ 已延后 ${task.id} ${minutes}min`)
    break
  }

  case 'status': {
    const q = await api('/api/queue')
    const stats = await api('/api/stats').catch(() => ({ claudeProcesses: '?' }))
    if (q.current) {
      const c = q.current
      console.log(`\n→ 当前: ${fmtPriority(c.priority)} ${c.title || '(无标题)'}  [${c.liveState || '-'}]`)
    } else {
      console.log('\n→ 当前: (空)')
    }
    console.log(
      `  待处理 ${q.waiting.length + (q.current ? 1 : 0)} | 稍后 ${q.deferred.length} | 已完成 ${q.done.length} | 🔵 ${stats.claudeProcesses} 个 claude 在跑\n`
    )
    break
  }

  case 'install-hooks': {
    const r = installHooks()
    console.log(`✓ Commander hook 已安装`)
    console.log(`  emit 脚本: ${r.emitScript}`)
    console.log(`  settings:  ${r.settingsPath}`)
    if (r.backup) console.log(`  已备份:    ${r.backup}`)
    console.log(`  新增事件:  ${r.added.length ? r.added.join(', ') : '(已存在，已更新)'}`)
    console.log(`\n  现有的 notify-*.sh / vibe-island hook 不受影响（追加而非覆盖）。`)
    break
  }

  case 'uninstall-hooks': {
    const r = uninstallHooks()
    console.log(`✓ 已移除 ${r.removed} 条 Commander hook（其他 hook 未动）`)
    if (r.backup) console.log(`  已备份: ${r.backup}`)
    break
  }

  default:
    console.log(`Commander ⚡ — AI 多实例实时指挥台

用法:
  commander serve [--port 3890]          启动服务 + Web UI（含 hook 采集 + 扫描兜底）
  commander install-hooks                安装 Claude Code 全局 hook（追加，不覆盖现有）
  commander uninstall-hooks              移除 Commander 装的 hook
  commander status                       终端速查：当前任务 + 队列 + 几个 claude 在跑
  commander add [title] [选项]           手动添加任务
      -p0/-p1/-p2/-p3 | -p <P1>           优先级 (默认 P2)
      -t <type>                          类型 (decision/review/deep_work/quick_action)
      -c <context>                       上下文摘要
      --session-id <id> --cwd <dir> --cmd <command> --agent <type>
  commander list                         列出队列
  commander done [id]                    完成当前/指定任务
  commander skip [id]                    跳过
  commander defer [id] [minutes]         延后 (默认 60min)

别名: cmd（等同 commander）
`)
}
