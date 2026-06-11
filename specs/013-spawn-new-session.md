# 013 — 网页内启动全新 session

- **状态**: done
- **优先级**: 中
- **作者**: yinshucheng
- **创建**: 2026-06-11
- **依赖**: 005（converse-ux，复用 spawn + stream-json + ws converse 模式）、009（queue-semantics-and-panel，面板分组）

## 背景 / 动机

目前 commander 只能**被动发现**会话：hook 事件流 + scanner 扫 `~/.claude/projects`，没有任何「主动启动一个全新 session」的路径（唯一 spawn 子进程的 `converse.js` 永远带 `--resume`）。

痛点：每次想在某个项目里开一个新活，都得切回终端 `cd <项目> && claude`，再等 commander 扫到/hook 报上来。批阅台本应「皇帝批奏章」一站式，开新会话却要离席回终端，断了心流。

## 目标

在网页面板（Board）的**项目分组头**点「＋ 新会话」，填一句首条任务消息，即在该项目目录下 spawn 一个全新的 `claude -p <消息>` 进程；新会话秒级纳入队列并在面板/批阅台可见，其增量进展复用现有 converse ws 通道实时回显。

### 非目标

- **不做空会话**：`claude -p` 非交互模式必须带 prompt，纯占位会话起不来，本次不支持。
- **本次只做面板分组头一个入口**。RailBar 全局「＋ 新会话」、TaskCard 内「同项目开新会话」为后续（技术方案已能复用，留作 follow-up）。
- 不做「在任意自定义目录开会话」——项目来源限定为已发现 session 的 `workingDir` 去重（即分组头自带的目录）。自定义路径入口留待 RailBar 那一期。
- 不改调度内核（`scheduler.js` `rank()`）。新会话经标准 `upsertFromAgent` 入队，走既有排序。

## 需求

作为指挥者，我想在面板里某个项目分组的标题旁点一下、填一句话，就在那个项目目录下开一个新的 Claude 会话，以便不离开网页就能派活，并立刻在队列里看到它跑起来。

## 验收标准

- [ ] Board 每个**有真实 workingDir 的项目分组头**显示「＋ 新会话」按钮；`(无项目)` 组不显示（无目录可用）。
- [ ] 点击弹出轻量输入（项目目录只读展示 + 首条消息文本框），填消息提交后关闭。
- [ ] 提交后后端在该 `workingDir` 下 spawn `<launcher> -p <消息> --output-format stream-json --verbose`（**不带 --resume**），launcher 从 `cmdTemplate` 派生（与续话同源）。
- [ ] 新进程的 `session_id`（来自 stream-json 首个 `system`/`init` 事件）被捕获并 `upsertFromAgent` 入队，**秒级**出现在面板（不靠 30s scanner）。
- [ ] 捕获失败时 scanner 30s 内兜底发现，新会话不丢。
- [ ] 新会话的进展增量经 ws `type:'converse'` 推到前端（复用现有渲染）。
- [ ] 消息为空时前端禁止提交 / 后端 400。
- [ ] 同一目录已有进行中的「网页新建」时单飞拒绝（避免误连点开两个）。
- [ ] `node -e` 直接调 `startSession` 能在某目录起一个 claude 进程并拿到 session_id（真实运行路径验证）。
- [ ] 回归测试：`parseStreamLine`（或抽出的 `extractSessionId`）能从 `system/init` 行正确抽出 `session_id`；`board-group.js` 分组项带上代表性 `workingDir`。

## 技术方案

### 后端

**1. `converse.js` 扩展 `parseStreamLine` 捕获 session_id**

当前只解析 `assistant`/`result`。新增：遇到 `ev.type === 'system'`（claude stream-json 的 init 事件，含 `session_id` 字段）时回调 `onSession(ev.session_id)`。把 session_id 抽取做成可单测的纯函数 `extractSessionId(ev)` 便于回归。

**2. `converse.js` 新增 `startSession({ workingDir, text })`**

照搬 `sendMessage` 的 launcher 派生与 spawn 骨架，差异：

- 不带 `--resume <sid>`：`args = [...baseArgs, '-p', prompt, '--output-format', 'stream-json', '--verbose']`。
- `cwd = workingDir`（必填，来自分组头）。
- 单飞键改用 `workingDir`（同目录并发拒绝），不是 sessionId（开始时还没有）。
- stdout 解析到 session_id 后：
  - 调 `upsertFromAgent({ claudeSessionId, sessionId, workingDir, projectRoot: workingDir, source: 'hook', liveState: 'running', lastEventAt: Date.now() })`（tasks.js）→ 立即建隐式 task 入队 + 广播 `queue_updated`。
  - 把 inflight 的键从 workingDir 迁移/补记到 sessionId，并广播一条 `type:'converse', sid, phase:'start'`，让前端把后续 delta 挂到这个 sid。
- delta / done 广播与续话一致（`type:'converse'`），done 后 `liveState` 落到 `waiting`。
- 5 分钟超时兜底、stderr 忽略噪音，同 `sendMessage`。

**3. 路由 `index.js` 新增 `POST /api/sessions/new`**

body `{ workingDir, text }`。校验 `workingDir` 非空且 `text` 非空（否则 400），调 `startSession`，回 `{ ok, sid?, error? }`。挂在 Sessions 区块（index.js:164 附近）。本期不带图片，走默认 json 解析即可（无需像 `/send` 那样开 25mb）。

### 前端

**4. `board-group.js`：分组项带上代表性 workingDir**

`insertionGroups` 产出的组目前只有 `{key,label,items}`。给 project 维度的组补一个 `workingDir`：取组内第一个 task 的 `sessionDetails[0].workingDir`（`(无项目)` 组为空）。纯函数改动，配单测。

**5. `api.js` 新增 `newSession({ workingDir, text })`** → `POST /api/sessions/new`。

**6. `Board.jsx` 分组头加入口**

`board-group-head` 内、`g.workingDir` 存在时渲染「＋ 新会话」按钮；点击展开内联输入（项目路径只读 + textarea + 提交/取消），提交调 `api.newSession` 后 `onAct` 刷新 + toast。空消息禁用提交。

### 与架构基线的对接

- 新会话经标准 `upsertFromAgent` 汇入，**不碰调度内核**，符合 `000-architecture.md`「内核稳定，来源可插拔」——这只是新增一条「主动 spawn」的来源。
- hook 优先级（`LIVE_RANK`）不变：这条新建会话标 `source:'hook'`、`liveState:'running'`，后续真实 hook（Stop/Notification）正常覆盖。

## 任务拆解

1. `converse.js`：抽 `extractSessionId(ev)` + 扩展 `parseStreamLine` 加 `onSession`。
2. `converse.js`：实现 `startSession({workingDir,text})`（spawn 无 resume + 捕获 session_id 调 upsertFromAgent + ws 广播 + 单飞 + 超时）。
3. `index.js`：`POST /api/sessions/new` 路由。
4. 重启 node，`node -e` 真起一个会话验证拿到 sid 并入队。
5. `board-group.js`：组带 `workingDir` + 更新 `test/board-group.test.mjs`。
6. `api.js`：`newSession`。
7. `Board.jsx`：分组头「＋ 新会话」内联输入 + 提交。
8. `styles.css`：按钮与内联输入样式（贴合现有 board-group-head）。
9. `test/`：`extractSessionId` 回归断言 + board-group workingDir 断言。
10. `pnpm test` + `pnpm build` + 浏览器实测在某项目开一个新会话并看到它入队/回显。

## 风险 / 待定

- **stream-json 的 init 事件字段名**：claude 原生与 ccr 透传是否都叫 `system` / `session_id` 需真机确认（任务 4 一并验）。抓不到也有 scanner 兜底，不致命，但秒级反馈依赖它。
- **进程游离**：spawn 出的 claude 在 commander 进程下，commander 重启会留下孤儿进程吗？续话已有此模式，沿用其行为，不在本期处理。
- **同目录多会话**：单飞只挡「网页新建中」，不挡「该目录已有别的会话在跑」——这是允许的（一个项目可多会话），符合数据模型。

## 实现记录

**落地文件**：
- `src/server/converse.js`：抽出 `extractSessionId(ev)` 纯函数；`parseStreamLine` 加可选 `onSession` 回调；新增 `startSession({workingDir,text})`——spawn 无 `--resume`、按 `workingDir` 单飞、捕获首个带 session_id 的事件后 `upsertFromAgent` 入队并广播 ws `converse`、5min 超时。
- `src/server/index.js`：`POST /api/sessions/new`（校验非空 → `startSession`）。
- `src/client/board-group.js`：新增 `workingDirOf(task)`；project 维度的组补 `workingDir`（组内首个 task 的真实目录，`(无项目)` 组为空）。
- `src/client/api.js`：`newSession({workingDir,text})`（不走 `req` 的 throw，以便拿到 4xx error 文案）。
- `src/client/Board.jsx`：`NewSessionInline` 内联输入组件 + 分组头「＋ 新会话」按钮（`groupBy==='project' && g.workingDir` 时显示，同时只展开一个）。
- `src/client/styles.css`：`.bg-new` / `.ns-*` 样式 + `.q-act:disabled`。
- 测试：`test/converse.test.mjs` 加 `extractSessionId` 4 例；`test/board-group.test.mjs` 加 `workingDirOf` + 组带 workingDir 断言。

**真机验证关键发现**：ccr/claude 的 stream-json **第一行**（`type:'system'`）就带 `session_id`，字段名正是 `session_id`——风险项「init 事件字段名」确认无误，秒级纳管成立（无需等 `subtype:'init'`，更不必等 scanner 30s）。HTTP 路径实测：空消息/缺目录 → 400；正常启动 → 5s 内以 `liveState:'running'`、正确 title/workingDir 入队。会话跑完后 scanner 末状态判定会接管 liveState（finish 设的 `waiting` 被覆盖为 `idle`），符合「scan 兜底接管」的既有语义。

**与原方案偏差**：无功能性偏差。单飞键按 `workingDir`（开始时尚无 sid），拿到 sid 后再把 inflight 键补成 sid 复用续话的并发体系。

**后续（本期未做，技术已就绪）**：RailBar 全局「＋ 新会话」（需自定义目录输入 + 项目下拉）、TaskCard 内「同项目开新会话」。
