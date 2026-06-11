# 010 — 续话支持多轮澄清（权限 skip 兜底）

- **状态**: done
- **优先级**: 高
- **创建**: 2026-06-10
- **依赖**: [005-converse-ux](005-converse-ux.md)（焦点不抢走）

## 背景 / 动机

面板里给会话发消息走的是 `claude -p`（print / 非交互模式，见 `converse.js`）。这个模式一次性、跑完即退、**无 stdin 交互通道**（`converse.js` 还主动 `child.stdin?.end()`）。由此带来两类「界面无法操作」：

1. **权限请求**：`-p` 模式不会弹可交互的确认。
2. **澄清反问**：模型反问「你是指 A 还是 B?」会作为 assistant 文本流式推给前端，但：
   - 该轮 `-p` 进程 `result` 后立即 `close`，`inflight` 删除、会话标回 `waiting`。
   - **前端从不把流式 `reply` 沉淀进 `msgs` 历史**（`TaskCard.jsx` `done` 分支注释了「追加历史」却没实现）。
   - 下一轮 `doSend` 又 `setReply('')` 把上一轮 AI 回复直接清掉。

结果：用户看到反问 → 想接着答 → 一发送，上一条反问消失，且视觉上对话不连续，体感「没法多轮」。

## 目标

- **权限**：续话命令带 `--dangerously-skip-permissions`，在 Commander 受控场景下放行工具调用（不阻塞）。当前默认 `cmdTemplate` 已带，需确认 `converse.js` 透传链路并补默认兜底。
- **澄清**：网页续话可连续多轮。每轮 AI 回复沉淀进 transcript 历史并在面板可见，下一轮基于同一 `--resume` 上下文继续。

### 非目标

- 不接入真正的交互式 PTY 双向通道（那是更大的「新内容来源」，另开 spec）。
- 不改 liveState 排序逻辑本身（焦点问题归 005）。

## 需求

- 作为用户，我在面板里回复一个会话，AI 反问时我能直接在同一个输入框接着答，不丢失上一轮内容。
- 多轮之间共享同一会话上下文（claude 自身的 `--resume` transcript）。
- 工具调用（含需权限的命令）在受控前提下默认放行，不会静默卡住。

## 验收标准

- [ ] 续话命令实际带 `--dangerously-skip-permissions`（透传自 `cmdTemplate`，且模板缺失时有兜底）
- [ ] 一轮续话结束后，AI 回复并入 `msgs` 历史，不被下一轮清空
- [ ] 连续发第二、三条消息，面板能看到完整多轮往返
- [ ] 多轮共享上下文：第二轮能引用第一轮的内容（claude `--resume` 落到同一/续接 transcript）
- [ ] `running` 态会话仍禁止网页注入（不回退既有保护）
- [ ] 回归测试：覆盖「流式回复沉淀进历史」的根因层断言

## 技术方案

### 权限（小）
- `converse.js`：`launcher` 取 `--resume` 之前的整段，已含模板里的 flag。补一个兜底——模板不含 `--dangerously-skip-permissions` 时，对续话注入该 flag（受控场景）。打印/日志不泄露其它内容。

### 多轮澄清（主）
- **前端 `TaskCard.jsx`（根因层）**：`done` 分支把累计的 `reply` 文本作为一条 `assistant` 消息 `setMsgs((prev) => [...prev, {seq:-1, role:'assistant', text: reply, ts}])`，然后再 `setReply('')`。`doSend` 不在发送瞬间清空旧 reply 之前要先确保上一轮已沉淀（done 已处理则天然不冲突）。
- **会话 id 串联（待实测）**：`claude -p --resume <sid>` 在部分版本会 fork 出**新 sid**而非续写原文件。需实测：
  - 若续写原文件 → 无需改后端 sid 追踪。
  - 若 fork 新 sid → 后端需从 stream-json 的 `session_id` 字段捕获新 sid，回写 `session.claudeSessionId`，下一轮 `--resume` 用新 sid，并通知前端切 sid（否则 `findSessionFile` 找不到新内容）。
- **后端 `converse.js`**：`done` 推送里带上本轮实际使用/新生成的 `sid`，前端据此对齐。

### 验证路径
- 改后端 → `pkill + 重启 node`（模块缓存坑）。
- 实测多轮：面板连发两条，第二条引用第一条 → 看 transcript 是否连续。
- `node --test test/converse.test.mjs` 跑根因断言。

## 风险 / 待定

- **`--resume` 是否 fork 新 sid** 是最大不确定点，须先实测再定后端改动范围（一次只改一个变量）。
- skip 权限是安全取舍：仅在 Commander 受控、用户已信任的本机会话场景成立；不得扩大到网络暴露场景。

## 实现记录

**先观测（钉死两个最大不确定点）**：起一个全新 `ccr code -p ... --output-format stream-json` 会话拿到 sid `255d…`，再 `--resume` 同一 sid 问「刚才让你记住的数字」——

- 第二轮 `session_id` **仍是 `255d…`，不 fork 新 sid**；答出 `42`，**上下文连续**。
- init 事件 `permissionMode: "bypassPermissions"`、`permission_denials: []` —— `--dangerously-skip-permissions`（模板已带，`converse.js` launcher 取 `--resume` 前整段透传）**已生效，权限那一半本就工作**。

→ 结论收窄：**后端 sid 追踪/权限均无需改动**，唯一真正的 bug 在前端。

**根因 + 修复**：
- 根因在 `TaskCard.jsx` `done` 分支：累计的流式 `reply` 从不并入 `msgs`，下一轮 `doSend` 的 `setReply('')` 直接清掉 → 多轮断裂、对话不连续。
- 抽出纯函数 `src/client/converse-fold.js` `foldReplyIntoHistory(msgs, reply, ts)`（根因层，可 import 测）：非空 reply 追加为一条 assistant 历史，空则不动，裁剪首尾空白，不就地改入参。
- `TaskCard.jsx`：新增 `replyRef` 与 `reply` 同步（delta 累加、done/doSend/切换会话时清零）；`done` 时 `setMsgs(foldReplyIntoHistory(prev, replyRef.current, Date.now()))` 沉淀历史再清空缓冲。用 ref 而非在 `setReply` updater 里嵌套 `setMsgs`，避开 React 严格模式下 updater 双调导致的重复追加。

**回归测试**：`test/converse-fold.test.mjs` 4 条，覆盖「非空追加 / 多轮不互清 / 空不追加 / 裁剪且不改原数组」。临时把实现改成 bug 行为验证测试有区分力（3 fail），还原后全过。`pnpm test` 27/27、`pnpm build` 通过。

**待人工端到端**：浏览器里非 running 会话连发两条、第二条引用第一条，确认面板完整呈现多轮往返（逻辑层已验证，仅剩 UI 呈现确认）。
