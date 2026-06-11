# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

Commander ⚡ —— AI 多实例实时指挥台,「像皇帝批阅奏章一样」管理多个 Claude Code 会话。机器上正在跑的 Claude Code 会话会自动汇聚成卡片,按「谁在等你」排序供逐条审阅/续话/调度。

## 命令

```bash
pnpm install                          # 用 pnpm，不是 npm

./start.sh                            # 首选：一键拉起（缺 dist 自动构建 + 装 hook + 起服务 + 开浏览器）
./start.sh --port 4000 --no-open      # 开关：--port/--build/--install-hooks/--open 及 --no-* 反向
./start.sh --help                     # 全部开关

pnpm build                            # vite 构建前端到 dist/（server 托管它）
pnpm dev                              # server(3890) + vite(5173) 并行，前端热更
pnpm dev:client                       # 只起 vite 开发服务器

# 也可绕过脚本直接调（start.sh 内部就是调它们）：
node bin/commander.js serve --port 3890   # 起服务（默认端口 3890）
node bin/commander.js install-hooks       # 装全局 Claude Code hook（追加，不覆盖）
node bin/commander.js status              # 终端速查队列
```

无 lint 配置。测试用 Node 内置 runner：`pnpm test`（= `node --test "test/**/*.test.mjs"`，测试文件后缀为 `.test.mjs`）。跑单个测试文件：`node --test test/scheduler.test.mjs`。验证靠：`pnpm test` 通过 + `pnpm build` 通过 + 浏览器实测 + `node -e` 直接 import server 模块跑函数。

### ⚠️ 改后端必须重启 node 进程

server 模块在进程启动时被缓存。**改 `src/server/*.js` 后只 `pnpm build` 不生效**,必须重启:

```bash
pkill -f "commander.js serve"; node bin/commander.js serve --port 3890
```

只改前端则 `pnpm build`（或 `pnpm dev` 热更）即可,无需重启 server。

> ⚠️ **并行开发时别用 `pkill -f`**——它会无差别杀掉所有 worktree 的 server。在 worktree 里改后端,用 `scripts/wt.sh restart`(只按本 worktree 的专属端口定位并重起)。见下「多特性并行开发」。

## 架构大图

两层。**调度内核稳定,内容来源/渲染可插拔**——这条边界是设计基线,见 `specs/000-architecture.md`,新接入来源不得改内核。

### 数据怎么进来（两条源,scanner 兜底 hook）

```
Claude Code hook ──► ~/.commander/events.jsonl ──► events.js（tail 读新行）─┐
                                                                          ├─► upsertFromAgent()
~/.claude/projects/*.jsonl ──► scanner.js（周期扫描，末状态判定）──────────┘   (tasks.js)
```

- **events.js**：消费 hook 写的事件流(精确,waiting/completed ~95%)。默认只读启动后的新行。
- **scanner.js**：扫 `~/.claude/projects` 的会话 jsonl,靠 mtime 静默阈值(180s)+ 末条事件角色判定 waiting/idle(兜底,~70%,漏报为主)。
- **`upsertFromAgent`**（`tasks.js`）是两条源的汇合点：会话 upsert → 自动建/更新「隐式 task」→ 入队。**hook 数据优先级高于 scan**(`LIVE_RANK`),scan 不能把 hook 设的精确态覆盖回近似态。

### 任务 ↔ 会话模型（`tasks.js` + `scheduler.js`）

- 一个 **task** 聚合若干 **session**。会话发现时自动建 `implicit: true` 的隐式 task。
- **排序优先级**（`scheduler.js` `rank()`）：P0 置顶 → **liveState 权重 `waiting > completed > running > idle`**(让等你的先冒出来) → 优先级 P0-P3 → skipCount 降权 → queuedAt 升序。
- 操作:`done`/`skip`(重排到同档末尾)/`defer`(定时 `tickDefer` 到点复活)/`dismiss`(标记会话 `dismissed`,不再被扫描复活,除非来新的 waiting hook)。
- 任何改队列的操作走 `notifyChange()` → 持久化 + ws 广播 `queue_updated`,current 变了再推 `new_current`。

### transcript 渲染（结构化 parts）

- **`transcript.js` `getSessionContext`**：把会话 jsonl 解析成结构化消息,每条 `{seq, role, ts, parts[], text}`。`parts` 的 `kind ∈ text|thinking|tool_use|tool_result|todos`。
- 后端做 **`tool_use.id ↔ tool_result.tool_use_id` 配对**,结果挂在 `tool_use.result` 上,并吸收/丢弃独立的 tool_result 噪音消息。
- 保留顶层 `text`（parts 拼成）作兼容字段,供 LLM 分析 / firstMessage。
- 前端 **`parts.jsx`**：`MessagePart` 按 `kind` 分发到 DiffPart(Edit/Write,jsdiff 行级 diff)/BashPart(命令高亮+折叠输出)/FilePart(Read/Grep/Glob/LS 折叠)/ThinkingPart/TodoPart/GenericToolPart。highlight.js 按需注册 ~13 种语言。
- **`SourceView`**（`TaskCard.jsx`）按 `source.type` 分发：`claude`→结构化渲染；`codex`/`web`→占位(架构预留,见 specs 002/003)。

### 网页续话（`converse.js`）

面板里给某会话发消息 → 在该会话 `workingDir` 下 spawn `<launcher> -p <text> --resume <sid> --output-format stream-json`,解析 stream-json 增量,经 ws `type:'converse'` 推前端。**launcher 从 `cmdTemplate` 派生**(取 `--resume` 之前的前缀):新装的默认是原生 `claude --dangerously-skip-permissions`,老配置(缺 `cmdTemplate` 字段)沿用旧默认 `ccr code`(`config.js` `LEGACY_CMD_TEMPLATE`)。**`running` 态会话禁止网页注入**(可能有活终端),并发单飞,5 分钟超时。

### 前端

React + Vite,`App.jsx` 经 `api.js`(含 ws `onConverse`)连后端。`TaskCard` 展示 current 任务 + 关联会话面板 + transcript;`Queue`/`Overview`/`Settings`/`AddTask` 为侧栏视图。

## 状态与配置的存放（关键约束）

- **运行时状态** → 仓库内 `data/{tasks,sessions,history}.json`（`store.js`,原子写 tmp+rename）。**`data/` 已 gitignore**(含本机路径与会话内容,不入库)。
- **用户配置** → `~/.commander/config.json`（`config.js`）。含 `cmdTemplate`(续话命令模板,默认走 ccr)、LLM 分析的 `analyzeApiKey` 等。
- **密钥(SiliconFlow 等)只存 `~/.commander/config.json`,绝不入库、不硬编码、打印时脱敏。** `/api/config` 明文返回 key 仅在 localhost 可接受,若暴露到网络必须改。

## Hook 安装的安全约束

`install-hooks.js` 把 `commander-emit.sh` 装成 Claude Code 全局 hook(Notification→waiting / Stop→completed / SessionStart→running / SessionEnd→closed)。**追加而非覆盖**,用 `commander-emit.sh` 标记识别自己装的条目以便幂等/卸载。

**改 hook 安装逻辑时务必保留用户已有的 hook**——尤其 Red Alert 提示音(`notify-waiting.sh`/`notify-done.sh`)和 vibe-island hook 不能丢。`~/.claude/settings.json` 会先备份(`.commander-bak`)。

## 通过 ccr 时的网络坑

本环境的 web 调用经 ccr(claude-code-router)代理。**`WebSearch` 工具会 400 报错**(`input_schema: Field required`)——改用 tavily MCP 工具(`mcp__tavily__tavily_search` / `tavily_extract`)。

## 开发流程

按改动大小走两条分支。

### 大特性 / 起点干净 → spec 驱动

动手前先在 `specs/NNN-<slug>.md` 写规格(背景/目标/验收标准/技术方案/任务拆解),定稿确认再实现。`specs/README.md` 是索引 + 工作流;`specs/000-architecture.md` 是不可违反的架构基线;`.plans/` 放实现期临时笔记(可丢)。接到需求时**先读 `specs/README.md`**。

### Bugfix / 小改动 → 观测驱动 + 回归测试

**主线**：复现 → 定位根因 → 在根因层写一个会失败的测试(red) → 修复 → 测试通过(green) → 留存防回归。

硬规则(每次都遵守,治「反复横跳/方向跑偏」):

1. **先观测后动手**：用一条证据(`node -e` 跑函数 / `evaluate_script` 查 DOM / `curl` 打接口)钉死现象,**确认 bug 真的存在**,再改代码。没有观测不动手。
2. **追到根因层**：显式回答「这是症状还是根因?」,沿数据/控制流往上游读。测试要写在**根因层,不是症状层**——否则会「修好测试但没修好 bug」。
   - 反例:markdown 不换行,症状在 `<p>` 标签,根因在三层外 `renderContent` 折叠了 `\n`。该断言 `getSessionContext` 的 `text` 保留 `\n`,而非断言某个 `<p>`。
3. **一次只改一个变量**,改完立即观测。同时改多处 = 修好了不知道是哪处起作用,反复的温床。
4. **验证打在真实运行路径上**：build 成功 ≠ 验证通过;改后端记得 `pkill + 重启 node`(见上文模块缓存坑)。
5. **每个 bugfix 配一条回归断言**,加进 `test/`。

例外(别教条)：复现不出来时,第一优先级是「想办法让它能复现」(加日志/观测),不是硬写测试;一次性笔误等不值得搭测试的,当场手动验一次即可,但「先观测、确认存在、改完真验证」任何情况不能省。

## 多特性并行开发

多个**基本独立**的特性同时推进时,用 `git worktree` 强隔离:每个特性一个独立目录 + 分支 + 端口,代码互不污染、进度互不丢失。完整设计见 `specs/014-parallel-feature-workflow.md`。

```bash
scripts/wt.sh new codex-source     # 开 worktree(.worktrees/codex-source,分支 feat/codex-source,从 origin/main 起,自动分配端口 + pnpm install)
scripts/wt.sh list                 # 看所有 worktree:分支 / 分配端口 / 该端口是否在跑
cd .worktrees/codex-source
../../scripts/wt.sh serve           # 在专属端口起服务(缺 dist 自动 build),可与主目录 3890 并存
../../scripts/wt.sh restart         # 改后端后只重启「这个」worktree 的 server(不误杀别的)
../../scripts/wt.sh rm codex-source # 干完移除(有未提交/未合并改动会拒绝,需 --force)
```

**为什么这套能行(项目特有约束)**:

- `data/{tasks,sessions,history}.json` 是**仓库内相对路径**(`store.js`),每个 worktree 自带独立 `data/`,队列状态天然隔离。
- 端口靠 `COMMANDER_PORT` env 注入(`bin/commander.js` 已支持)。**主目录恒用 3890,worktree 从 3891 递增**,端口号记在各 worktree 的 `.commander-port`(gitignore)。
- `~/.commander/config.json`(续话模板/API key)和 hook 事件源是**全局共享的**——同一个用户、同一套真实 Claude 会话,本就该看到同样的 live 数据,不隔离。

**硬规则**:

1. **改 worktree 的后端,用 `wt.sh restart` 不用 `pkill -f "commander.js serve"`**——后者会杀掉所有 worktree 的 server。
2. **每个 worktree 开工前、合并前各 `git rebase origin/main` 一次**,减小漂移。
3. **合并前在该 worktree 跑 `pnpm test` + `pnpm build` 通过**。
4. **新建 spec 前先 `ls specs/` 看最大编号**——并行时编号易撞(本 spec 就从 012 顺延到 014);撞了往后顺延,别覆盖别人的。
5. 若两特性确实碰了同一核心文件(scheduler/tasks/App.jsx),**先合冲突小的,后者 rebase 吸收前者**。

### 测试

无第三方测试框架,用 Node 内置 runner：`node --test test/`(`package.json` 的 `pnpm test`)。后端纯函数最好测(`node:assert` 直接断言);前端行为用留存的 `evaluate_script` 断言脚本。**只为「修过的 bug」和「核心不变量」写测试**,不追覆盖率——半年下来 `test/` 就是这个项目踩过的坑的可执行清单。
