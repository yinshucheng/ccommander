import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

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
import { sendMessage, saveUploads } from './converse.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dirname, '../../dist')

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

  // ---- Sessions ----
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

  server.listen(port, () => {
    console.log(`\n  ⚡ Commander 运行在 http://localhost:${port}`)
    console.log(`     hook 事件 → ~/.commander/events.jsonl  |  扫描兜底已启动`)
    if (!existsSync(DIST)) {
      console.log(`  ℹ  前端未构建。开发模式请另跑 \`pnpm dev:client\` (vite @5173)`)
      console.log(`     或 \`pnpm build\` 后由本服务托管。\n`)
    } else {
      console.log('')
    }
  })

  return server
}
