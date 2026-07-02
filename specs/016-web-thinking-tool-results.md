# 016 — 网页续话显示思考过程 + 工具调用结果

- **状态**: accepted
- **优先级**: 高
- **作者**: shilin
- **创建**: 2026-06-16
- **依赖**: [001-structured-transcript](001-structured-transcript.md)（已有的 parts 渲染）、[015-web-interactive-permission-clarify](015-web-interactive-permission-clarify.md)（长驻 stream-json 通道）

## 背景 / 动机

网页续话现在的体验比真终端少两大块内容：

1. **思考过程（thinking blocks）完全没有**。模型用 thinking 时,终端能看到折叠的推理链;网页上看到的是"沉默 30 秒突然蹦答案"。`converse.js parseStreamLine` 没有 `thinking_delta` 分支,既不推增量也不存。
2. **工具调用只显示"调用了 X",看不见结果**。`parseStreamLine` 第 146 行只 `onText('[调用工具: ${p.name}]')`,而 `tool_result`(在 stream-json 的 `user` 事件里,带 `tool_use_id`)被整体丢弃。用户看见"我查了文件"但查了啥不知道,看见"我跑了命令"但输出是啥不知道——agent 在做什么完全不透明。

但奇怪的是,**刷新页面后,这些内容反而出现了**——因为 `transcript.js getSessionContext` 是按 `~/.claude/projects/*.jsonl` 重建的,claude 子进程自己把 thinking 和 tool_result 都写进了 jsonl,`parts.jsx` 也已经有 ThinkingPart / DiffPart / BashPart / FilePart 完整渲染。

→ **缺的不是渲染、不是存储,只是续话进程的"实时增量推送"漏掉了这两类事件**。

## 目标

网页续话进行中,thinking blocks 和工具调用结果都以增量形式实时推到前端,渲染样式复用已有的结构化 parts 组件;刷新后从 jsonl 重读得到的版本与实时增量看到的一致(不双显、不缺失)。

### 非目标

- **不自己往 jsonl 写**。claude 子进程会写,我们只负责把它产生的 stream-json 事件实时推前端。避免双写冲突 + scanner 误读。
- 不改 transcript.js 的 jsonl 重建逻辑(已经对的)。
- 不引入新的 part kind——`thinking` / `tool_use` / `tool_result` 在 `transcript.js` 里都已有定义,本 spec 只补"增量阶段"产出它们。
- 不改前端 `parts.jsx` 的 ThinkingPart / DiffPart 等渲染组件本身——只让它们也能消费"增量流"的同构数据。

## 需求

- 作为用户,在网页续话面板看着模型回复时,**思考过程实时显示**(可折叠,默认折叠),与终端体验一致。
- 作为用户,模型调用 `Read` / `Edit` / `Bash` 等工具时,**实时看到结果**:Read 的文件头几行、Bash 的 stdout、Edit 的 diff,而不是只看见 `[调用工具: X]` 然后陷入黑箱。
- 作为用户,刷新页面后,实时看到的内容和刷新后从 jsonl 重建看到的内容**一致**——不重复、不缺失、顺序对。

## 验收标准

- [ ] `parseStreamLine` 识别 `content_block_delta.delta.type === 'thinking_delta'` 并通过新的回调 `onThinking(text, blockId)` 推前端(partial 模式逐字)
- [ ] `parseStreamLine` 识别非 partial 模式 `assistant.content[].type === 'thinking'`,推完整 thinking 块(防漏)
- [ ] `parseStreamLine` 识别 `user.message.content[].type === 'tool_result'`,通过新回调 `onToolResult({tool_use_id, content, is_error})` 推前端
- [ ] ws 消息扩展:新增 `type: 'converse'` 的 phase 值 `thinking_delta` / `tool_result`,payload schema 文档化(便于第三方接入)
- [ ] 前端 `App.jsx onConverse` 处理新 phase,在当前 turn 的实时 transcript 里追加对应 part(数据结构与 `transcript.js` 输出的 part 同构)
- [ ] TaskCard 实时渲染区复用 `MessagePart`(parts.jsx),thinking 可折叠,tool_result 按 toolName 走 DiffPart/BashPart/FilePart/GenericToolPart
- [ ] 刷新页面后,从 jsonl 重建的 transcript 不与实时增量重复(因为实时增量本就是"显示用",刷新后被 jsonl 版本完全替代——保持现有"刷新即 reset 实时 buffer"的逻辑)
- [ ] 回归测试 `test/converse.test.mjs` 新增:
  - thinking_delta 事件被正确解析,触发 onThinking
  - assistant 含 thinking part 被解析(非 partial)
  - user 含 tool_result 被解析,触发 onToolResult
  - tool_result.is_error=true 被透传(前端可显示错误样式)
- [ ] `pnpm test` 通过、`pnpm build` 通过、浏览器实测一轮带 Read+Bash+Edit 的续话:思考过程实时出现 → 工具调用结果实时填充 → 刷新后内容一致

## 技术方案

### 数据流

```
claude stream-json stdout
   │
   ├─ stream_event { content_block_delta thinking_delta }     ─► onThinking(text)
   ├─ stream_event { content_block_delta text_delta }         ─► onText(text)            (已有)
   ├─ assistant { content: [thinking, text, tool_use, ...] }  ─► 分发到 onThinking / onText / onText('[调用工具]')
   └─ user      { content: [tool_result] }                    ─► onToolResult({...})    (新)
                                                                          │
                                                                          ▼
                                                              broadcast({type:'converse', phase:'tool_result', sid, payload})
                                                                          │
                                                                          ▼
                                                          前端 onConverse 落到 liveParts[] 数组(按 sid 隔离)
                                                                          │
                                                                          ▼
                                                          TaskCard 用 <MessagePart> 渲染 liveParts
```

### 关键模块改动

**`src/server/converse.js`**

1. `parseStreamLine` 增加两个回调:`onThinking(text, blockId?)`、`onToolResult({tool_use_id, content, is_error})`
2. partial 模式 thinking 跟 text 一样按 blockId 累加(不同 thinking block 之间换行分隔)
3. 非 partial 模式扫 `assistant.content[]` 时,`type === 'thinking'` → onThinking 推 `thinking_text`,与 text 共用现有的 `sawPartialThisTurn` 防重复机制
4. `child.stdout.on('data')` 的 `parseStreamLine` 调用补两个回调,各自 broadcast 新 phase

**ws schema**(都在 `type: 'converse'` 下)

| phase | payload | 时机 |
|---|---|---|
| `start` | — | 已有 |
| `delta` | `text` | 已有,text 增量 |
| `thinking_delta` | `text`, `blockId?` | **新**,thinking 增量 |
| `tool_use` | `id`, `name`, `input` | **新**,工具被调用(目前埋在 `delta` 文字里,拆出来更结构化) |
| `tool_result` | `tool_use_id`, `content`, `is_error` | **新** |
| `done` | `result`, `ok` | 已有 |

> `tool_use` 单拆是为了让前端能把 result 挂到对应 use 上(同 transcript.js 的 use↔result 配对)。短期可选——若工程量超预算,前端先用纯文本 `[调用工具: X]` 也能跑,只是看不到入参摘要。

**`src/client/api.js`**

`onConverse` 已有的回调签名 `(msg) => void` 不变,只是 msg.phase 多了几个值——业务代码在 App.jsx 里处理,api 层零改动。

**`src/client/App.jsx`**

维护 `liveParts: Map<sid, Part[]>`。收到:
- `delta` → 末尾如果是 text part 就追加,否则 push 新 text part
- `thinking_delta` → 同理但 push thinking part
- `tool_use` → push tool_use part(带 id)
- `tool_result` → 找同 `tool_use_id` 的 tool_use part 挂 result,找不到就 push 独立 tool_result part(tolerant)
- `done` → 清掉本 sid 的 liveParts(由 jsonl 重建的 transcript 接管)
- `start` → 清掉本 sid 的 liveParts(新一轮)

**`src/client/TaskCard.jsx`**

`SourceView` 渲染 transcript 后,在末尾追加 `liveParts[currentSid]?.map(p => <MessagePart part={p} />)`。

### 与现有结构的对接

- `transcript.js` 的 part schema 不变。**实时增量产出的 part 必须与 jsonl 重建产出的 part 字段完全同构**(同名、同形状),这样 `MessagePart` 一套渲染两边通吃。具体字段:
  - `text`: `{kind:'text', text}`
  - `thinking`: `{kind:'thinking', text}`
  - `tool_use`: `{kind:'tool_use', name, input, id, result?}`
  - `tool_result`(独立挂):`{kind:'tool_result', tool_use_id, content, is_error}`(jsonl 重建时一般被合并进 tool_use.result,实时阶段独立挂兜底)

### 不破坏调度内核

零触碰 `scheduler.js` / `tasks.js`。仅扩展 `converse.js` 的解析 + ws phase + 前端实时渲染层。

## 任务拆解

按依赖顺序:

1. **`parseStreamLine` 扩展回调** + 单测(`test/converse.test.mjs` 加 3 个 case:thinking_delta / assistant 含 thinking / user 含 tool_result)
2. **`converse.js` ensureProc 的 stdout 处理串起新回调**,broadcast 新 phase
3. **前端 `App.jsx` liveParts 状态** + `onConverse` 处理新 phase
4. **`TaskCard.jsx` SourceView 末尾渲染 liveParts**(复用 MessagePart)
5. **删掉 `parseStreamLine` 里的 `'[调用工具: ${p.name}]'` 文本拼接**(被 tool_use phase 取代);保留作为 partial 模式下若 tool_use 缺 id 时的兜底
6. **手动验证**:一轮含 Read + Bash + Edit 的续话,实时三段都显示;刷新 → 内容不变
7. **回归测试 + pnpm build + pnpm test**

## 风险 / 待定

- **风险:partial 模式下 thinking block 的 stop 事件**。Anthropic 文档里 thinking block 用 `content_block_start` / `content_block_delta` / `content_block_stop` 分段,我们目前不跟踪 `content_block_stop`。如果一条 turn 里有多个 thinking block,前端可能粘在一起。**缓解**:把 `blockId`(取自 content_block_start 的 `index`)透传给前端,前端按 blockId 分段。
- **风险:tool_result.content 可能是 array(多 part) 或 string**。Anthropic SDK 两种格式都有。`onToolResult` 把 content 原样透传,前端做 `typeof content === 'string' ? content : content.map(...)` 兼容。
- **待定:tool_use 单拆 phase 是否本期做**。倾向**做**——理由:前端有了 input 才能给 DiffPart 提供 `oldString/newString`,否则等 jsonl 重建才能看到 diff。如果工程量爆,降级方案:tool_use 继续走文字 delta,tool_result 单独推。
- **不做:实时 transcript 写盘**。一旦写盘就要处理与 claude 自己写的 jsonl 的合并/去重,工程量翻几倍。"实时只用于显示、刷新由 jsonl 接管"是更小的代价。

## 实现记录

(完成后填)
