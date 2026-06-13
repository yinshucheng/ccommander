import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync, accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter } from 'node:path'

import { init, getSessions, persist } from './store.js'
import { addClient } from './bus.js'
import {
  buildCurrent,
  buildQueue,
  buildOverview,
  createTask,
  patchTask,
  doneTask,
  skipTask,
  deferTask,
  undeferTask,
  dismissTask,
  tickDefer,
} from './tasks.js'
import { startEvents } from './events.js'
import { startScanner, countClaudeProcesses } from './scanner.js'
import { getConfig, patchConfig } from './config.js'
import { getSessionContext } from './transcript.js'
import { analyzeSession } from './analyze.js'
import { sendMessage, saveUploads, startSession } from './converse.js'
import { requestPermission, resolvePermission, checkToken, setInternalUrl } from './perm-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dirname, '../../dist')

// 某个可执行文件是否在 PATH 中。纯探测，无副作用。
// 不经 shell：自行遍历 $PATH 查可执行文件，避免把 bin 拼进 sh -c 造成命令注入/误判
//（曾经 `command -v "x; printf y"` 因 printf 存在而误返回 true）。
export function isOnPath(bin) {
  // 只接受安全的可执行名 token；含空格/分号/斜杠等一律判 false
  if (typeof bin !== 'string' || !/^[A-Za-z0-9._-]+$/.test(bin)) return false
  const dirs = (process.env.PATH || '').split(pathDelimiter).filter(Boolean)
  for (const dir of dirs) {
    const full = join(dir, bin)
    try {
      if (!statSync(full).isFile()) continue
      accessSync(full, fsConstants.X_OK)
      return true
    } catch {
      // 不存在 / 不可执行 / 无权限 → 试下一个目录
    }
  }
  return false
}

// hook 是否已安装：~/.claude/settings.json 含 commander-emit.sh 标记
function isHookInstalled() {
  try {
    const p = join(homedir(), '.claude', 'settings.json')
    if (!existsSync(p)) return false
    return readFileSync(p, 'utf8').includes('commander-emit.sh')
  } catch {
    return false
  }
}

// 组装启动自检报告（纯函数，注入探测结果便于测试）。
// probe: { distExists, claudeOnPath, ccrOnPath, hookInstalled, cmdTemplate }
export function buildHealthReport({ port, distExists, claudeOnPath, ccrOnPath, hookInstalled, cmdTemplate }) {
  const lines = []
  lines.push(`✓ 端口 ${port}`)
  lines.push(distExists ? '✓ 前端已构建' : '⚠ 前端未构建 — 运行 `pnpm build`（或用 `./start.sh` 自动构建）')
  lines.push(claudeOnPath ? '✓ claude 可用' : '⚠ claude 不在 PATH — 续话需要它')
  if (ccrOnPath) lines.push('✓ 检测到 ccr（如需走代理，可在 Settings 把 cmdTemplate 改为 ccr code …）')
  lines.push(hookInstalled ? '✓ hook 已安装' : '⚠ hook 未安装 — 运行 `install-hooks`（或 `./start.sh`）')

  // 续话结论：取 cmdTemplate 首个词，核对是否在 PATH
  const first = String(cmdTemplate || '').trim().split(/\s+/)[0] || ''
  let resumeBin = first
  // 形如 "ccr code ..." 实际依赖的是 ccr；"claude ..." 依赖 claude
  const binOk = resumeBin === 'ccr' ? ccrOnPath : resumeBin === 'claude' ? claudeOnPath : isOnPath(resumeBin)
  lines.push(`续话将用: ${first || '(未配置)'} ${binOk ? '✓' : '⚠ 该命令不在 PATH，续话可能失败'}`)

  return lines
}

export function startServer({ port = 3890 } = {}) {
  init()

  const app = express()
  // 续话路由可能带 base64 图片，跳过全局 100kb 解析，交由该路由自己的高限额解析器处理
  app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/send$/.test(req.path)) return next()
    return express.json()(req, res, next)
  })

  // ---- Tasks ----
  app.get('/api/current', (req, res) => res.json({ task: buildCurrent() }))
  app.get('/api/queue', (req, res) => res.json(buildQueue()))

  app.post('/api/tasks', (req, res) => res.json(createTask(req.body)))
  app.patch('/api/tasks/:id', (req, res) => {
    const t = patchTask(req.params.id, req.body)
    if (!t) return res.status(404).json({ error: 'not found' })
    res.json(t)
  })
  app.post('/api/tasks/:id/done', (req, res) => {
    const t = doneTask(req.params.id, req.body?.notes)
    if (!t) return res.status(404).json({ error: 'not found' })
    res.json(t)
  })
  app.post('/api/tasks/:id/skip', (req, res) => {
    const t = skipTask(req.params.id)
    if (!t) return res.status(404).json({ error: 'not found' })
    res.json(t)
  })
  app.post('/api/tasks/:id/defer', (req, res) => {
    const t = deferTask(req.params.id, req.body?.minutes ?? 60)
    if (!t) return res.status(404).json({ error: 'not found' })
    res.json(t)
  })
  app.post('/api/tasks/:id/undefer', (req, res) => {
    const t = undeferTask(req.params.id)
    if (!t) return res.status(404).json({ error: 'not found' })
    res.json(t)
  })
  app.post('/api/tasks/:id/dismiss', (req, res) => {
    const t = dismissTask(req.params.id)
    if (!t) return res.status(404).json({ error: 'not found' })
    res.json(t)
  })

  // ---- 统计 / 全局视角 ----
  app.get('/api/stats', (req, res) => res.json({ claudeProcesses: countClaudeProcesses() }))
  app.get('/api/overview', (req, res) => res.json(buildOverview()))

  // ---- 配置 ----
  app.get('/api/config', (req, res) => res.json(getConfig()))
  app.patch('/api/config', (req, res) => res.json(patchConfig(req.body)))

  // ---- 会话上下文 / 分析 ----
  app.get('/api/sessions/:sid/context', (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    const before = req.query.before != null ? Number(req.query.before) : undefined
    res.json(getSessionContext(req.params.sid, { limit, before }))
  })
  app.post('/api/sessions/:sid/analyze', async (req, res) => {
    res.json(await analyzeSession(req.params.sid))
  })
  // 续话可带图片（base64），单独提高 body 限制；图片落临时文件后以 @path 注入 prompt
  app.post('/api/sessions/:sid/send', express.json({ limit: '25mb' }), async (req, res) => {
    const text = (req.body?.text || '').trim()
    const images = Array.isArray(req.body?.images) ? req.body.images : []
    if (!text && !images.length) return res.status(400).json({ ok: false, error: '消息为空' })
    let imagePaths = []
    try {
      imagePaths = await saveUploads(images)
    } catch {
      return res.status(500).json({ ok: false, error: '图片保存失败' })
    }
    const r = sendMessage(req.params.sid, text, imagePaths)
    res.status(r.status || 200).json(r)
  })

  // ---- 权限审批（spec 015）----
  // 内部端点：perm-server.js（我们 spawn 的 MCP 子进程）POST 进来一个权限请求并长轮询，
  // 我们挂起、广播 permission_request 给前端，用户答复后才 res.json({decision})。
  // token 校验防本机其它进程伪造；只绑在本地（与整个 server 同 host）。
  app.post('/internal/permission', express.json({ limit: '5mb' }), async (req, res) => {
    if (!checkToken(req.body?.token)) return res.status(403).json({ error: 'forbidden' })
    const decision = await requestPermission({
      sid: req.body?.sid || '',
      tool_name: req.body?.tool_name || '',
      input: req.body?.input ?? {},
      tool_use_id: req.body?.tool_use_id || '',
    })
    res.json({ decision })
  })

  // 公开端点：用户在网页点「允许/拒绝」→ 回灌决定，resolve 对应挂起请求。
  app.post('/api/sessions/:sid/permission', express.json({ limit: '5mb' }), (req, res) => {
    const toolUseId = req.body?.tool_use_id || ''
    const decision = req.body?.decision
    if (!toolUseId || !decision) return res.status(400).json({ ok: false, error: '缺少 tool_use_id 或 decision' })
    const hit = resolvePermission(toolUseId, decision)
    res.json({ ok: hit, matched: hit })
  })

  // ---- Sessions ----
  // 网页内启动全新会话（不带 --resume）：在指定项目目录下 spawn claude -p <text>
  app.post('/api/sessions/new', (req, res) => {
    const workingDir = (req.body?.workingDir || '').trim()
    const text = (req.body?.text || '').trim()
    if (!workingDir) return res.status(400).json({ ok: false, error: '缺少项目目录' })
    if (!text) return res.status(400).json({ ok: false, error: '消息为空' })
    const r = startSession({ workingDir, text })
    res.status(r.status || 200).json(r)
  })
  app.get('/api/sessions', (req, res) => res.json(getSessions()))
  app.patch('/api/sessions/:id', (req, res) => {
    const store = getSessions()
    const s = store.sessions.find((x) => x.id === req.params.id)
    if (!s) return res.status(404).json({ error: 'not found' })
    Object.assign(s, req.body)
    persist('sessions')
    res.json(s)
  })

  // ---- 静态前端（生产构建产物）----
  if (existsSync(DIST)) {
    app.use(express.static(DIST))
    app.get('*', (req, res) => res.sendFile(join(DIST, 'index.html')))
  } else {
    // 未构建：返回明确提示页，而非白屏。API 路由已在上方注册，不受影响。
    app.get('*', (req, res) =>
      res
        .status(503)
        .send(
          '<!doctype html><meta charset=utf-8>' +
            '<body style="font-family:system-ui;padding:3rem;line-height:1.6">' +
            '<h1>⚡ Commander 前端尚未构建</h1>' +
            '<p>请先运行 <code>pnpm build</code>（或用 <code>./start.sh</code> 自动构建），然后刷新本页。</p>' +
            '</body>'
        )
    )
  }

  const server = createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws) => {
    addClient(ws)
    // 连接即推一次当前状态
    ws.send(JSON.stringify({ type: 'queue_updated', queue: buildQueue() }))
  })

  // 周期检查 defer 到点
  setInterval(tickDefer, 30 * 1000)

  // 事件采集：hook 事件流 + 扫描兜底
  startEvents()
  startScanner()

  // 端口占用等监听错误：友好提示并退出。
  // 注意 listen 错误会同时由 http server 与挂在其上的 WebSocketServer 重新 emit；
  // 两者都要挂监听，否则 wss 的无人监听 'error' 会被 Node 当未捕获异常抛出。
  const onListenError = (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  ✗ 端口 ${port} 已被占用。换个端口：serve --port <其它端口>，或 ./start.sh --port <其它>\n`)
      process.exit(1)
    }
    console.error(e)
    process.exit(1)
  }
  server.on('error', onListenError)
  wss.on('error', onListenError)

  server.listen(port, () => {
    // 权限审批内部端点（perm-server 子进程回连用）：绑本机回环 + 端口
    setInternalUrl(`http://127.0.0.1:${port}/internal/permission`)
    console.log(`\n  ⚡ Commander 运行在 http://localhost:${port}`)
    console.log(`     hook 事件 → ~/.commander/events.jsonl  |  扫描兜底已启动\n`)
    const report = buildHealthReport({
      port,
      distExists: existsSync(DIST),
      claudeOnPath: isOnPath('claude'),
      ccrOnPath: isOnPath('ccr'),
      hookInstalled: isHookInstalled(),
      cmdTemplate: getConfig().cmdTemplate,
    })
    report.forEach((l) => console.log(`     ${l}`))
    console.log('')
  })

  return server
}
