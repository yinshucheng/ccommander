#!/usr/bin/env node
// Commander launcher（可选）。
//
// 借鉴 happy-cli/scripts/claude_local_launcher.cjs：包一层目标 CLI（claude / 任何
// node 写的 CLI），hook global.fetch，把 fetch-start/fetch-end 通过 fd 3 上报给父
// 进程 —— 父进程据此精确维护「正在思考」状态（比心跳法准 ~200ms）。
//
// 仅当 cmdTemplate 是 node 实现的 CLI（如原生 claude）时有用；ccr 是外部二进制，
// hook 不到它转发给真正 claude 的那段网络 —— 走 ccr 的用户不需要启用它。
//
// 用法：在 commander Settings 里把 cmdTemplate 改成：
//   node /path/to/commander_launcher.cjs <target-cli-absolute-path> [extra-args...]
// 或者通过环境变量：COMMANDER_TARGET=/abs/path/to/claude <launcher> [args...]
//
// 父进程默认给我们开 fd 3（converse.js 的 ensureProc 已加 stdio:[…, 'pipe']）；
// fd 3 不可用时 writeMessage 静默忽略，launcher 仍然能跑（只是丢失精度）。

const fs = require('fs')
const path = require('path')

function writeMessage(msg) {
  try {
    fs.writeSync(3, JSON.stringify(msg) + '\n')
  } catch {
    /* fd3 not available, ignore */
  }
}

// Hook global.fetch —— 仅在 fetch 存在时（Node 18+ 自带）
if (typeof global.fetch === 'function') {
  const orig = global.fetch
  let counter = 0
  global.fetch = function (...args) {
    const id = ++counter
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''
    let host = 'unknown'
    let pth = url
    try {
      const u = new URL(url, 'http://localhost')
      host = u.hostname
      pth = u.pathname
    } catch {
      /* ignore */
    }
    writeMessage({ type: 'fetch-start', id, hostname: host, path: pth, timestamp: Date.now() })
    const p = orig.apply(this, args)
    const end = () => writeMessage({ type: 'fetch-end', id, timestamp: Date.now() })
    p.then(end, end)
    return p
  }
  Object.defineProperty(global.fetch, 'name', { value: 'fetch' })
}

// 解析目标 CLI：argv[2] 或 $COMMANDER_TARGET
const target = process.argv[2] || process.env.COMMANDER_TARGET
if (!target) {
  process.stderr.write('commander_launcher: 缺少目标 CLI 路径（argv[2] 或 $COMMANDER_TARGET）\n')
  process.exit(2)
}
const targetAbs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target)

// 把目标 CLI 当作 Node 模块加载（它自己处理 argv）。
// 调整 process.argv：去掉 launcher 自己 + target，余下原样保留。
process.argv = [process.argv[0], targetAbs, ...process.argv.slice(3)]
try {
  require(targetAbs)
} catch (e) {
  process.stderr.write(`commander_launcher: 无法加载目标 ${targetAbs}: ${e.message}\n`)
  process.exit(1)
}
