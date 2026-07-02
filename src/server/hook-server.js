// 进程级 hook server（每个长驻续话进程一个）。
//
// 借鉴 happy-cli/src/claude/utils/startHookServer.ts：用 --settings 把 hook 配置
// 注入到我们 spawn 的 claude/ccr 子进程，hook 通过 HTTP POST 把事件直接送到本
// 进程的 127.0.0.1 随机端口 —— 不写全局 ~/.claude/settings.json，不污染用户其它
// claude 实例，多 commander 并发不串号。
//
// 与全局 commander-emit.sh 叠加：全局 hook 负责「用户在终端外手动跑的 claude」，
// 进程 hook 负责「commander 自己 spawn 的长驻进程」—— 后者带回来的 sid 永远是
// 那一个 spawn 出来的 claude 自己的 sid（包括 /compact 后 fork 的新 sid，第 3 项用）。

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SETTINGS_DIR = join(tmpdir(), 'commander-hook-settings')

let sharedServer = null
let sharedPort = 0
// sid -> 回调集合。一条 hook 进来时按 session_id 分发到订阅该 sid 的回调。
// 我们在 spawn 前并不知道新 sid（依赖 hook 自己报回来），所以也允许 listener 用
// '*' 通配订阅，第一条命中的 hook 完成后会把 listener 重新绑到具体 sid 上。
const listeners = new Map() // sid -> Set<{ onSessionStart, onStop, onNotification }>
const wildcards = new Set() // 新 spawn 进程：第一条 hook 来时确认 sid 并迁移

// 启动（或返回已启动的）共享 hook server。返回 port。
// 共享是因为多个长驻进程共用同一个 server 即可（POST body 自带 session_id），
// 省得开一堆端口。
export async function startProcHookServer() {
  if (sharedServer) return sharedPort
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // 只接 POST /hook/<event>
      const m = /^\/hook\/(session-start|stop|notification)$/.exec(req.url || '')
      if (req.method !== 'POST' || !m) {
        res.writeHead(404).end('not found')
        return
      }
      const eventName = m[1]
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let data = {}
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          /* ignore */
        }
        const sid = data.session_id || data.sessionId || ''
        dispatch(eventName, sid, data)
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
      })
      req.on('error', () => {
        if (!res.headersSent) res.writeHead(500).end('err')
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('hook server: bad address'))
        return
      }
      sharedServer = server
      sharedPort = addr.port
      // 别让 server 单独把 event loop 撑住 —— 主 server（commander 自己）和 ws 会撑住；
      // 测试/无活客户端场景下进程能正常退出。
      if (typeof server.unref === 'function') server.unref()
      resolve(sharedPort)
    })
  })
}

function dispatch(eventName, sid, data) {
  // 先派给具体 sid 的订阅者
  const set = sid ? listeners.get(sid) : null
  if (set) {
    for (const cb of set) fireOne(cb, eventName, sid, data)
  }
  // 再派给通配（新 spawn 等首条 hook 的 listener）：第一条命中的就把它绑到 sid 上
  for (const cb of [...wildcards]) {
    fireOne(cb, eventName, sid, data)
    if (sid && cb._bindOnFirst) {
      wildcards.delete(cb)
      let s = listeners.get(sid)
      if (!s) {
        s = new Set()
        listeners.set(sid, s)
      }
      s.add(cb)
      cb._bindOnFirst = false
    }
  }
}

function fireOne(cb, eventName, sid, data) {
  try {
    if (eventName === 'session-start') cb.onSessionStart?.(sid, data)
    else if (eventName === 'stop') cb.onStop?.(sid, data)
    else if (eventName === 'notification') cb.onNotification?.(sid, data)
  } catch {
    /* 一个 listener 抛错不能阻塞分发 */
  }
}

// 订阅某个 sid（或新 spawn 进程用 '*' 通配，首条 hook 后自动绑到具体 sid）
// 返回取消订阅函数。
export function subscribe(sid, cb) {
  if (sid === '*') {
    cb._bindOnFirst = true
    wildcards.add(cb)
    return () => wildcards.delete(cb)
  }
  let s = listeners.get(sid)
  if (!s) {
    s = new Set()
    listeners.set(sid, s)
  }
  s.add(cb)
  return () => {
    s.delete(cb)
    if (s.size === 0) listeners.delete(sid)
  }
}

// 生成临时 settings.json，给 spawn 的 claude/ccr 用 --settings 传入。
// 四个 hook：
//   - SessionStart  → POST /hook/session-start（拿到真正的 session_id；compact/fork 也会触发）
//   - Stop          → POST /hook/stop          （一轮 result，进 waiting）
//   - Notification  → POST /hook/notification  （idle_prompt / permission_prompt = 等用户）
//   - PreToolUse    → 直接 POST commanderApiPort 的 /api/clarify-wait（30 min 长轮询）
//                     与全局 settings 的 PreToolUse 行为一致：网页 spawn 的进程也享有
//                     AskUserQuestion / ExitPlanMode 弹卡片体验。
//
// hook command 用 curl —— claude hook 是任意 shell 命令，curl 在 macOS/Linux 默认有。
//
// 返回临时 settings.json 路径，spawn 用完即可调 cleanupHookSettings(path) 删掉。
// commanderApiPort：主进程对外服务端口（默认 3890），PreToolUse 用它定位 /api/clarify-wait。
export function writeHookSettings(port, tag, commanderApiPort = 3890) {
  mkdirSync(SETTINGS_DIR, { recursive: true })
  const safeTag = String(tag || `${process.pid}-${Date.now()}`).replace(/[^\w.-]/g, '_')
  const path = join(SETTINGS_DIR, `hook-${safeTag}.json`)
  const url = (ev) => `http://127.0.0.1:${port}/hook/${ev}`
  // claude 把 hook 事件 JSON 从 stdin 传入；用 curl 直转。-s 静默、-m 5 超时 5s 避免阻塞 claude。
  const cmd = (ev) =>
    `cat | curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- ${url(ev)} >/dev/null 2>&1 || true`
  // PreToolUse 不同：要拿响应（hookSpecificOutput JSON）打回 stdout 给 claude，
  // 且 30 min 长轮询。失败兜底输出 {"continue":true} 让 claude 走默认。
  const clarifyUrl = `http://127.0.0.1:${commanderApiPort}/api/clarify-wait`
  const clarifyCmd =
    `resp="$(cat | curl -sS --max-time 1830 -H 'Content-Type: application/json' --data-binary @- ${clarifyUrl} 2>/dev/null)"; ` +
    `if [ -n "$resp" ]; then printf '%s\\n' "$resp"; else printf '{"continue":true}\\n'; fi`
  const settings = {
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('session-start'), timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop'), timeout: 5 }] }],
      Notification: [
        // 与 install-hooks.js 一致：只接 idle_prompt / permission_prompt（其他子类型不算等用户）
        { matcher: 'idle_prompt', hooks: [{ type: 'command', command: cmd('notification'), timeout: 5 }] },
        { matcher: 'permission_prompt', hooks: [{ type: 'command', command: cmd('notification'), timeout: 5 }] },
      ],
      PreToolUse: [
        {
          matcher: 'AskUserQuestion|ExitPlanMode',
          hooks: [{ type: 'command', command: clarifyCmd, timeout: 1800 }],
        },
      ],
    },
  }
  writeFileSync(path, JSON.stringify(settings, null, 2))
  return path
}

export function cleanupHookSettings(path) {
  if (!path) return
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

// 测试用：关掉共享 server 让 event loop 退出
export function _closeForTest() {
  if (sharedServer) {
    try {
      sharedServer.close()
    } catch {
      /* ignore */
    }
    sharedServer = null
    sharedPort = 0
    listeners.clear()
    wildcards.clear()
  }
}
