// converse.js 回归测试 —— 钉住「网页续话支持粘贴图片」的核心不变量。
// 跑: pnpm test  (= node --test test/)
//
// saveUploads 把前端 base64 data URL 落成临时文件，路径以 @path 注入 prompt。
// 不变量：① 正确解码并写盘；② 文件名无空格（否则 @path 在 prompt 里按空格被切断）；
//         ③ 扩展名按 MIME 推断；④ 非法 data URL 被跳过而非抛错/产生坏文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, unlink } from 'node:fs/promises'
import { saveUploads } from '../src/server/converse.js'

// 1x1 像素 PNG（合法 base64），用作最小图片载荷
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('saveUploads 解码 base64 并写盘，路径无空格', async () => {
  const paths = await saveUploads([{ name: 'shot.png', dataUrl: `data:image/png;base64,${PNG_1PX}` }])
  try {
    assert.equal(paths.length, 1)
    const p = paths[0]
    assert.ok(!/\s/.test(p), `路径不应含空格: ${p}`) // 否则 @path 会被 prompt 的空格切断
    assert.match(p, /\.png$/)
    const buf = await readFile(p)
    assert.ok(buf.length > 0, '文件应有内容')
  } finally {
    for (const p of paths) await unlink(p).catch(() => {})
  }
})

test('saveUploads 按 MIME 推断扩展名', async () => {
  const paths = await saveUploads([
    { dataUrl: `data:image/jpeg;base64,${PNG_1PX}` },
    { dataUrl: `data:image/webp;base64,${PNG_1PX}` },
  ])
  try {
    assert.match(paths[0], /\.jpg$/)
    assert.match(paths[1], /\.webp$/)
  } finally {
    for (const p of paths) await unlink(p).catch(() => {})
  }
})

test('saveUploads 跳过非法 data URL，不抛错', async () => {
  const paths = await saveUploads([{ dataUrl: 'not-a-data-url' }, { dataUrl: '' }, {}])
  assert.deepEqual(paths, [])
})

test('saveUploads 空入参返回空数组', async () => {
  assert.deepEqual(await saveUploads([]), [])
  assert.deepEqual(await saveUploads(), [])
})
