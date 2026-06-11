// config cmdTemplate 默认值回归（对抗式审查发现 #2）。
// 跑: pnpm test
//
// 011 把默认 cmdTemplate 从 ccr 改成原生 claude。坑：{...DEFAULTS, ...parsed} 合并下，
// 「config.json 已存在但没写 cmdTemplate」的老用户会被静默升级到新默认（ccr→claude，行为倒退）。
// 不变量：① 首次创建 → 新默认 claude；② 缺字段的老配置 → 保留旧默认 ccr；
//         ③ 显式写了 cmdTemplate → 原样尊重。
// config.js 在模块加载期按 $HOME 定位 ~/.commander，且 getConfig() 有进程级 cache，
// 故每个 case 用独立子进程 + 独立 HOME 跑，互不污染。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '../..')

function renderWith(configJson /* string | null */) {
  const home = mkdtempSync(join(tmpdir(), 'cmdr-cfg-'))
  try {
    if (configJson !== null) {
      mkdirSync(join(home, '.commander'), { recursive: true })
      writeFileSync(join(home, '.commander', 'config.json'), configJson)
    }
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "import { renderCommand } from './src/server/config.js'; process.stdout.write(renderCommand('SID'))"],
      { cwd: ROOT, env: { ...process.env, HOME: home }, encoding: 'utf8' }
    )
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('首次创建（无 config.json）→ 默认走原生 claude', () => {
  assert.match(renderWith(null), /^claude .*--resume SID$/)
})

test('老配置存在但缺 cmdTemplate → 保留旧默认 ccr，不被静默升级', () => {
  const out = renderWith('{"contextRecentCount":7}')
  assert.match(out, /^ccr code .*--resume SID$/)
})

test('显式写了 cmdTemplate → 原样尊重', () => {
  const out = renderWith('{"cmdTemplate":"myrunner --resume {sessionId}"}')
  assert.equal(out, 'myrunner --resume SID')
})
