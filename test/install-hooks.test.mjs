// install-hooks.js 回归测试 —— 钉住「Notification hook 必须按 matcher 精筛」这条不变量。
// 跑: pnpm test  (= node --test test/)
//
// 修过的 bug:Commander 装的 Notification hook 没带 matcher,匹配所有 Notification
// 子类型(permission_prompt 时模型其实还在 mid-turn),把「权限询问」误吞成 waiting,
// 面板显示「等你输入」但实际还在模型调用中。
// 修法:Notification 只对 idle_prompt / permission_prompt 两个 matcher emit waiting,
// 绝不留无 matcher 的全吞条目;且对历史遗留的无 matcher 条目要能自愈清除。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHookGroups, ensureHook, installHooks } from '../src/server/install-hooks.js'

// buildHookGroups 是纯函数,直接测。
test('buildHookGroups: Notification 只产出带 matcher 的 group,不含全吞条目', () => {
  const groups = buildHookGroups({ type: 'waiting', matchers: ['idle_prompt', 'permission_prompt'] })
  assert.equal(groups.length, 2)
  const matchers = groups.map((g) => g.matcher).sort()
  assert.deepEqual(matchers, ['idle_prompt', 'permission_prompt'])
  // 根因断言:绝不能有「无 matcher」的 Notification group(那会匹配 auth_success 等全部子类型)
  assert.ok(
    groups.every((g) => typeof g.matcher === 'string' && g.matcher),
    'Notification group 必须带 matcher,否则会把权限询问/其它通知误判为 waiting',
  )
  // 命令仍指向我们的 emit 脚本、传 waiting
  for (const g of groups) {
    assert.match(g.hooks[0].command, /commander-emit\.sh waiting$/)
  }
})

test('buildHookGroups: 无 matchers 的事件产出单条无 matcher group', () => {
  const groups = buildHookGroups({ type: 'completed' })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].matcher, undefined)
  assert.match(groups[0].hooks[0].command, /commander-emit\.sh completed$/)
})

const WAITING_SPEC = { type: 'waiting', matchers: ['idle_prompt', 'permission_prompt'] }

// 根因回归:历史遗留的「无 matcher 的 Commander Notification 条目」必须被自愈清除,
// 换成两条带 matcher 的。否则全吞 bug 在升级用户身上复发。
test('ensureHook: 自愈清除无 matcher 的历史遗留全吞条目', () => {
  const settings = {
    hooks: {
      Notification: [
        // 别人的 hook —— 必须保留
        { matcher: 'idle_prompt', hooks: [{ type: 'command', command: 'bash notify-waiting.sh' }] },
        { matcher: '*', hooks: [{ type: 'command', command: 'vibe-island-bridge' }] },
        // Commander 旧版装的无 matcher 全吞条目 —— 必须被替换
        { hooks: [{ type: 'command', command: 'bash /x/.commander/bin/commander-emit.sh waiting', timeout: 5 }] },
      ],
    },
  }
  ensureHook(settings, 'Notification', WAITING_SPEC)
  const arr = settings.hooks.Notification
  const ours = arr.filter((g) => (g.hooks || []).some((h) => h.command.includes('commander-emit.sh')))
  // 我们的条目:恰好 2 条,且都带 matcher,无一无 matcher
  assert.equal(ours.length, 2)
  assert.deepEqual(ours.map((g) => g.matcher).sort(), ['idle_prompt', 'permission_prompt'])
  assert.ok(ours.every((g) => g.matcher), '不得残留无 matcher 的全吞条目')
  // 别人的 hook 原样保留
  assert.ok(arr.some((g) => g.hooks[0].command.includes('notify-waiting.sh')), 'notify-waiting 不能被动')
  assert.ok(arr.some((g) => g.hooks[0].command.includes('vibe-island')), 'vibe-island 不能被动')
})

// 幂等:重复 ensureHook 不累积重复 group。
test('ensureHook: 幂等,重复调用不累积', () => {
  const settings = {}
  ensureHook(settings, 'Notification', WAITING_SPEC)
  ensureHook(settings, 'Notification', WAITING_SPEC)
  ensureHook(settings, 'Notification', WAITING_SPEC)
  const ours = settings.hooks.Notification.filter((g) =>
    (g.hooks || []).some((h) => h.command.includes('commander-emit.sh')),
  )
  assert.equal(ours.length, 2, '反复装仍只有 idle_prompt + permission_prompt 两条')
})

test('installHooks 导出存在(冒烟,不实际调用以免写用户 settings)', () => {
  assert.equal(typeof installHooks, 'function')
})
