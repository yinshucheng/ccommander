// 启动自检回归测试 —— 钉住 specs/011 的不变量：
// 启动日志要把环境真相（dist/claude/ccr/hook）和「续话将用哪个命令、能不能用」讲清楚，
// 不能在缺依赖时静默白屏 / 静默续话失败。
// 跑: pnpm test  (= node --test test/)
//
// 断言打在纯函数 buildHealthReport 上（注入探测结果），与真实环境解耦。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHealthReport, isOnPath } from '../src/server/index.js'

const base = {
  port: 3890,
  distExists: true,
  claudeOnPath: true,
  ccrOnPath: false,
  hookInstalled: true,
  cmdTemplate: 'claude --dangerously-skip-permissions --resume {sessionId}',
}

test('全绿环境：dist/claude/hook 均 OK，续话用 claude 且可用', () => {
  const r = buildHealthReport(base).join('\n')
  assert.match(r, /✓ 前端已构建/)
  assert.match(r, /✓ claude 可用/)
  assert.match(r, /✓ hook 已安装/)
  assert.match(r, /续话将用: claude ✓/)
  // 没有 ccr 时不应出现 ccr 提示行
  assert.doesNotMatch(r, /检测到 ccr/)
})

test('未构建：给出 pnpm build 提示而非静默', () => {
  const r = buildHealthReport({ ...base, distExists: false }).join('\n')
  assert.match(r, /⚠ 前端未构建/)
  assert.match(r, /pnpm build/)
})

test('未装 hook：给出 install-hooks 提示', () => {
  const r = buildHealthReport({ ...base, hookInstalled: false }).join('\n')
  assert.match(r, /⚠ hook 未安装/)
})

test('cmdTemplate 用 ccr 但 ccr 不在 PATH → 续话标记为不可用', () => {
  const r = buildHealthReport({
    ...base,
    ccrOnPath: false,
    cmdTemplate: 'ccr code --dangerously-skip-permissions --resume {sessionId}',
  }).join('\n')
  assert.match(r, /续话将用: ccr ⚠/)
})

test('检测到 ccr 时给出切换提示', () => {
  const r = buildHealthReport({ ...base, ccrOnPath: true }).join('\n')
  assert.match(r, /检测到 ccr/)
})

test('cmdTemplate 用 claude 但 claude 不在 PATH → 续话标记为不可用', () => {
  const r = buildHealthReport({ ...base, claudeOnPath: false }).join('\n')
  assert.match(r, /⚠ claude 不在 PATH/)
  assert.match(r, /续话将用: claude ⚠/)
})

test('isOnPath：sh 自身一定在 PATH，乱码命令一定不在', () => {
  assert.equal(isOnPath('sh'), true)
  assert.equal(isOnPath('definitely-not-a-real-bin-xyz-123'), false)
  assert.equal(isOnPath(''), false)
})

// 回归（对抗式审查发现 #1）：旧实现把 bin 拼进 `sh -c "command -v $bin"`，
// 含 shell 元字符时会误判 true（命令注入/误报续话可用）。现在只接受安全 token。
test('isOnPath：含 shell 元字符的输入一律判 false，不经 shell', () => {
  assert.equal(isOnPath('definitely-not-real; printf injected'), false)
  assert.equal(isOnPath('claude && rm -rf /'), false)
  assert.equal(isOnPath('$(echo sh)'), false)
  assert.equal(isOnPath('`sh`'), false)
  assert.equal(isOnPath('claude foo'), false) // 含空格
  assert.equal(isOnPath('/bin/sh'), false) // 含斜杠（PATH 查找语义里不是裸名）
  assert.equal(isOnPath(null), false)
  assert.equal(isOnPath(undefined), false)
})
