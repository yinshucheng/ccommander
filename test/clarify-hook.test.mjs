// PreToolUse 澄清 hook 输出生成器 + install/进程级 settings 注入回归。
//
// 这是 task #12：终端 / 网页 spawn 的 claude 调 AskUserQuestion/ExitPlanMode 时，
// 走 PreToolUse hook → commander → 网页 PermissionCard → 决定按 claude hook 协议
// 喂回 claude。本测试钉以下不变量：
//
// 1) renderHookOutput 严格按 hookSpecificOutput 协议输出（permissionDecision +
//    updatedInput + permissionDecisionReason + additionalContext）
// 2) install-hooks 全局 settings.json 注入 PreToolUse(AskUserQuestion|ExitPlanMode)
//    + 用对脚本 + 用对超时
// 3) writeHookSettings 进程级 settings.json 同款注入
// 4) uninstall 能识别两种标签的脚本（emit + clarify），不动别人的 hook

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderHookOutput } from '../src/server/clarify-hook.js'
import { buildHookGroups, ensureHook } from '../src/server/install-hooks.js'
import { writeHookSettings } from '../src/server/hook-server.js'

// ── 1) renderHookOutput 输出契约 ─────────────────────────────

test('AskUserQuestion + allow + answers → updatedInput 合并 + additionalContext 列 Q&A', () => {
  const out = renderHookOutput(
    {
      behavior: 'allow',
      updatedInput: { answers: { '用哪个库?': 'react-query', '要 SSR?': '否' } },
    },
    'AskUserQuestion',
    { questions: [{ question: '用哪个库?', options: [] }] },
  )
  assert.equal(out.continue, true)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  assert.equal(out.hookSpecificOutput.updatedInput.answers['用哪个库?'], 'react-query')
  // 原始 input 字段保留（不能把 questions 弄丢）
  assert.ok(out.hookSpecificOutput.updatedInput.questions)
  // additionalContext 把回答列出来，兜底让 claude 一定能消费到
  assert.match(out.hookSpecificOutput.additionalContext, /react-query/)
  assert.match(out.hookSpecificOutput.additionalContext, /否/)
})

test('AskUserQuestion + allow 但没 answers → 还是 allow，不挂 updatedInput', () => {
  const out = renderHookOutput({ behavior: 'allow' }, 'AskUserQuestion', { questions: [] })
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  assert.equal(out.hookSpecificOutput.updatedInput, undefined)
  assert.match(out.hookSpecificOutput.additionalContext, /未提供具体回答/)
})

test('AskUserQuestion + deny + 原因 → permissionDecisionReason 带原因', () => {
  const out = renderHookOutput(
    { behavior: 'deny', message: '问题太宽泛，先看一下文件' },
    'AskUserQuestion',
    { questions: [] },
  )
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /问题太宽泛/)
})

test('ExitPlanMode + allow → permissionDecision allow + 批准上下文', () => {
  const out = renderHookOutput({ behavior: 'allow' }, 'ExitPlanMode', { plan: '...' })
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  assert.match(out.hookSpecificOutput.additionalContext, /批准/)
})

test('ExitPlanMode + deny + 原因 → 打回上下文带原因', () => {
  const out = renderHookOutput(
    { behavior: 'deny', message: '范围太大，拆成两步' },
    'ExitPlanMode',
    { plan: '...' },
  )
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.additionalContext, /范围太大/)
})

test('未知 decision 形态 → 不崩，默认 deny', () => {
  const out = renderHookOutput(null, 'AskUserQuestion', {})
  assert.equal(out.continue, true)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
})

// ── 2) install-hooks: PreToolUse 注入 ─────────────────────────

test('buildHookGroups: PreToolUse 用 clarify 脚本而非 emit + 30 min 超时', () => {
  const spec = {
    type: 'clarify',
    matchers: ['AskUserQuestion|ExitPlanMode'],
    commandBuilder: () => `bash /home/u/.commander/bin/commander-clarify.sh`,
    timeout: 1800,
  }
  const groups = buildHookGroups(spec)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].matcher, 'AskUserQuestion|ExitPlanMode')
  assert.match(groups[0].hooks[0].command, /commander-clarify\.sh/)
  // ✗ 不能拿 emit 脚本来当 PreToolUse
  assert.doesNotMatch(groups[0].hooks[0].command, /commander-emit\.sh/)
  assert.equal(groups[0].hooks[0].timeout, 1800)
})

test('ensureHook: PreToolUse 同时存在 emit 与 clarify 仍能识别为「我们装的」', () => {
  // 模拟一份历史 settings：用户其它 PreToolUse hook + 我们旧的 clarify
  const settings = {
    hooks: {
      PreToolUse: [
        // 别人的 hook
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/scripts/bash-guard.sh' }] },
        // 我们的旧版（要被替换）
        { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'bash /old/.commander/bin/commander-clarify.sh', timeout: 600 }] },
      ],
    },
  }
  ensureHook(settings, 'PreToolUse', {
    type: 'clarify',
    matchers: ['AskUserQuestion|ExitPlanMode'],
    commandBuilder: () => `bash /Users/me/.commander/bin/commander-clarify.sh`,
    timeout: 1800,
  })
  const arr = settings.hooks.PreToolUse
  const ours = arr.filter((g) => (g.hooks || []).some((h) => h.command.includes('commander-clarify.sh')))
  // 老的被替换，只剩一条新的
  assert.equal(ours.length, 1)
  assert.equal(ours[0].matcher, 'AskUserQuestion|ExitPlanMode')
  assert.equal(ours[0].hooks[0].timeout, 1800)
  // 别人的 Bash hook 保留
  assert.ok(arr.some((g) => g.hooks[0].command.includes('bash-guard.sh')), '别人的 Bash hook 不能被动')
})

// ── 3) writeHookSettings: 进程级注入 PreToolUse ─────────────────

test('writeHookSettings 写出的 settings 含 PreToolUse(AskUserQuestion|ExitPlanMode) 且指向正确端口', () => {
  // 进 tmp 跑（避免污染真实 /tmp/commander-hook-settings）
  const path = writeHookSettings(54321, `test-${Date.now()}`, 13890)
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  // PreToolUse 段存在
  assert.ok(Array.isArray(settings.hooks.PreToolUse))
  const ptu = settings.hooks.PreToolUse[0]
  assert.equal(ptu.matcher, 'AskUserQuestion|ExitPlanMode')
  // 命令里带 commander 自己的 API 端口（用户的 web port）
  assert.match(ptu.hooks[0].command, /127\.0\.0\.1:13890\/api\/clarify-wait/)
  // 30 min 超时
  assert.equal(ptu.hooks[0].timeout, 1800)
  // 进程级 hook server 自己的端口仍在另外几个 hook 里（54321）
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /127\.0\.0\.1:54321\/hook\//)
  assert.match(settings.hooks.Stop[0].hooks[0].command, /127\.0\.0\.1:54321\/hook\//)
})

test('writeHookSettings 兜底命令：commander 挂时输出 {"continue":true}', () => {
  const path = writeHookSettings(54322, `test-fallback-${Date.now()}`, 13891)
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command
  // 失败兜底必须存在 —— 否则 commander 挂了就阻塞用户终端 claude
  assert.match(cmd, /continue":true/)
})
