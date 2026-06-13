# 015 — 网页续话的交互式权限审批 + 澄清作答（L1 + L2）

- **状态**: done（L1+L2 已实现；L3 待另开 spec）
- **优先级**: 高
- **作者**: yinshucheng
- **创建**: 2026-06-12
- **依赖**: [010-converse-multiturn-clarify](010-converse-multiturn-clarify.md)（多轮历史沉淀）、[005-converse-ux](005-converse-ux.md)（焦点不抢走）
- **Supersedes**: 部分取代 010 的「权限 skip 兜底」——010 用 `--dangerously-skip-permissions` 闷头放行,本 spec 用真权限交互取代它

## 背景 / 动机

网页续话(`converse.js`)目前是 `<launcher> -p <text> --resume <sid>`,带 `--dangerously-skip-permissions`,且开局就 `child.stdin?.end()`。后果:

1. **权限被无条件跳过(L1 缺失)**:Claude 在网页续话里改文件/跑命令从不问你,「闷头干」。010 当时的取舍是「Commander 受控场景放行」,但用户要的是**像原生终端一样,该问我时弹给我、我点了才动**。
2. **澄清/计划无法作答(L2 缺失)**:`AskUserQuestion`(可选卡片)、`ExitPlanMode`(计划确认)这类需要用户实时拍板的交互,在 headless `-p` 模式下没有 TTY 可渲染,会直接失败——会话只能干瞪眼。这正是 [[headless-session-no-tty]] 记录的约束。

**进程模型决策:直接上长驻 stream-json 进程,不用 `-p` 短命模式。** 因为**长期一定要 L3**(进程长驻、像上朝面奏一样连续往返),若 L1+L2 先用 `-p` 短命做,L3 时进程模型整层要返工。一步到位用 `--input-format stream-json --output-format stream-json` 的长驻进程,L1+L2 的交互通道直接架在长驻进程上,L3 就只剩「把你的新消息回灌 stdin + UI 做成同步等待」的增量,**没有返工**。

**关键事实(已实测,2026-06-12,三块拼图全部经 ccr 跑通)**:

1. **权限工具透传**:default 权限模式 + 本地 stdio MCP server 暴露 `approve` 工具 + `--permission-prompt-tool mcp__perm__approve`。让 Claude `Write` 文件 → **`approve` 被调用**,拿到完整 `{tool_name, input, tool_use_id}`;返回 `{behavior:'deny'}` → Write 被拦、文件未创建、`permission_denials` 有记录、Claude 优雅继续;返回 `{behavior:'allow', updatedInput}` → 文件真创建。
2. **长驻双向 stream-json**:`--input-format stream-json` 长驻进程,喂两条 user 消息(NDJSON `{type:'user',message:{role:'user',content:[...]}}`),各自得到回复,**同一 sid 全程不变、上下文连续**(第一轮记 42、第二轮答 42)。
3. **长驻 + 权限同时挂**:长驻进程里触发 Write,`approve` 仍被调用、allow 生效、文件创建、进程不崩。
4. **skip 与 perm-tool 互斥(已实测)**:带 `--dangerously-skip-permissions` 时 `permissionMode=bypassPermissions`,`--permission-prompt-tool` **完全不被调用**、工具直接执行。→ 实现据此分两条路:**模板含 skip → 不挂 perm 工具(沿用现状,零变化);模板不含 skip → 挂 perm 工具 + `--permission-mode default` 走交互**。不存在「skip 还要 perm 工具返回 allow」的中间态。

→ 结论:`长驻进程 + 双向输入 + 权限/澄清回灌` 三者经 ccr 可同时工作。**无需直连原生 claude**(实测直连反而 `model_not_found`——本机模型访问依赖 ccr 路由)。L1/L2/L3 共用**同一个 permission-prompt-tool 通道**:权限审批是它,`AskUserQuestion`/计划确认也是它(answers 通过 permission 回调的 `updatedInput` 回填——见 Agent SDK `canUseTool` 文档)。

## 目标

网页续话拥有和原生 Claude Code 一致的「该问你时弹给你、你作答后继续」体验:工具权限审批(L1)与澄清/计划交互(L2)在面板里渲染成可操作卡片,你的决定回灌给会话,会话据此继续。

### 非目标

- **L3 的「同步上朝面奏」体验层不在本 spec**:实时逐字流(partial message streaming)、UI 上「守着等模型回复、它说完你当场答」的同步交互编排、长驻进程的断线重连/会话级常驻治理。本 spec **搭好长驻进程模型这个地基**(进程长驻、stdin 可回灌、权限/澄清通道),但 L1+L2 阶段仍是「你发一条 → 它跑完(含中途若干次权限/澄清往返)→ 等你下一条」的回合制;把它升级成「逐字流 + 同步守候」是 L3 的增量。详见末尾「L3:在本 spec 地基上的增量」。
- 不改调度内核(`scheduler.js`/`tasks.js` 的排序与状态语义),不破坏 `specs/000-architecture.md` 的「内核稳定、来源/渲染可插拔」边界。
- `running` 态禁止网页注入的保护需**重新定义**(见技术方案):长驻进程下网页自己就是那个活进程,旧的「running=可能有活终端」语义要调整,但不弱化「同一会话不被两个写入方同时注入」的核心保护。

## 需求

- 作为用户,网页续话里 Claude 要改文件/跑命令时,面板弹出「工具 + 入参 + 允许/拒绝」卡片,我点允许它才执行;拒绝则它收到拒绝原因并继续。
- 作为用户,Claude 反问(`AskUserQuestion`)时,面板渲染出可选项卡片(含 `preview`),我选了/填了「Other」后答案回灌,会话据此继续——和我今天在真终端看到的澄清组件一致。
- 作为用户,Claude 进入计划确认(`ExitPlanMode`)时,面板展示计划全文 + 「批准/打回」。
- 一轮续话内可发生**多次**权限/澄清往返,中途不丢失、不卡死;超时有兜底。

## 验收标准

- [ ] 续话进程模型改为**长驻 `--input-format stream-json --output-format stream-json`**(不再 `-p` 短命、不再开局 `stdin.end()`);进程随会话存活,消息经 stdin 喂 NDJSON `{type:'user',...}`
- [ ] **放行与否从 `cmdTemplate` 派生,不引入独立开关**:用户的 `cmdTemplate` 已含 `--dangerously-skip-permissions`(如当前默认)→ 全放行,perm 工具直接 allow、不弹审批(尊重用户已表达的「跳过权限」意图);模板不含 skip → 走 `--permission-mode default` + `--permission-prompt-tool` 交互审批。与项目「launcher 从 cmdTemplate 派生」的既有做法一致。
- [ ] Commander 内置一个本地 permission-prompt MCP server(stdio),作为续话子进程的 `--mcp-config` 注入;ccr 路径下 `mcp_servers` 显示它 `connected`
- [ ] 工具权限请求经 ws 推到前端,渲染「工具名 + 入参摘要 + 允许/拒绝」;用户决定经 ws 回灌,permission 工具据此返回 `{behavior:'allow'|'deny', updatedInput?, message?}`
- [ ] `AskUserQuestion` 在前端渲染为可选卡片(复用原生交互语义:多选/Other/preview),答案经 `updatedInput.answers` 回填
- [ ] `ExitPlanMode` 在前端渲染计划 + 批准/打回
- [ ] 一轮内多次往返不丢、不重复;权限请求有超时兜底(到点默认 deny 并提示,不让进程永久挂起)
- [ ] `running` 态注入保护重定义后仍守住「同一会话不被两个写入方同时注入」
- [ ] 回归测试:permission 工具的 allow/deny/updatedInput 协议在根因层(纯函数)可断言;ws 请求↔回灌的配对(按 `tool_use_id`)有测试;`autoApprove` 分支有测试
- [ ] 文档同步:`CLAUDE.md` 续话小节更新(进程模型从「`-p` 短命 skip 放行」改为「长驻 stream-json + 交互式审批」),`converse.js` 注释更新,本 spec 标 done 并填实现记录

## 技术方案

### 总体数据流

```
前端面板                  server(commander)              长驻续话进程(ccr code, stream-json)
   │                          │                                      │
   │                   spawn(随会话存活)注入:                         │
   │                   --input-format stream-json                    │
   │                   --output-format stream-json --verbose         │
   │                   --permission-mode default                     │
   │                   --mcp-config <内置 perm server>               │
   │                   --permission-prompt-tool mcp__commander__approve
   │  ── 发消息 ──────────────►│  ── 写 stdin NDJSON {type:'user'} ──►│
   │                          │                                      │
   │                          │   Claude 想用工具/反问 → 调 approve ──┤
   │                          │◄── perm server 收到 {tool_name,input,tool_use_id}
   │  ◄─ ws permission_request ┤   (模板含 skip → 直接 allow,不弹;
   │  (渲染审批/澄清/计划卡片)  │    不含 → 挂起,等前端答)
   │  ── ws permission_reply ─►│                                      │
   │     {tool_use_id,decision}│   resolve 挂起请求 ──────────────────►│
   │                          │   approve 返回 behavior/updatedInput  │ Claude 据此继续
   │  ◄─ ws converse delta ────┤◄── stdout stream-json 增量 ──────────┤
```

### 进程模型:长驻 stream-json（`converse.js` 核心改造）

- 现状:`-p <text> --resume <sid>` 短命进程 + `child.stdin?.end()`。改为:**会话级长驻进程**,`ccr code --resume <sid> --input-format stream-json --output-format stream-json --verbose`,**持有 stdin**,你的每条消息编码成 NDJSON `{type:'user',message:{role:'user',content:[{type:'text',text}]}}` 写进去(图片用 content 里的 image 块或沿用 @path)。
- `inflight` 语义从「这轮在不在跑」升级为「这条会话有没有活着的长驻进程」(`claudeSessionId -> {child, pending:Map<tool_use_id,resolve>, lastActiveAt}`)。
- 生命周期:首次发消息时按需 spawn;空闲超时(比如 N 分钟无往返)回收;会话 `dismiss`/`done` 时杀;进程 close/error 时清表并广播。**进程数治理**:每会话至多一个;可设全局上限,超限时 LRU 回收最久空闲的。
- `running` 态保护重定义:旧语义「running=可能有终端,禁注入」。长驻下「网页自己持有的长驻进程」是受控的,允许注入;但**别处(真终端/别的写入方)正在写同一会话**时仍禁止——以「本进程是否本会话的长驻持有者」为准,而非笼统看 liveState。
- **本 spec 阶段仍回合制**:发一条 → 等这条整轮(含权限/澄清往返)结束 → 你发下一条。逐字流 + 同步守候留给 L3。

### 内置 permission-prompt MCP server（新文件 `src/server/perm-server.js` + 一个独立可执行入口）

- `--permission-prompt-tool` 要求工具名形如 `mcp__<server>__<tool>`,server 经 `--mcp-config` 以 stdio 子进程方式挂载。**这个 MCP server 必须是独立进程**(不是 commander server 本身),由续话子进程作为 MCP 子进程拉起。
- 它与 commander 主进程之间需要一条回传通道,把「Claude 的权限请求」交给主进程(主进程才有 ws 连着前端)。两种实现取舍见「风险/待定」。倾向:**permission server 通过本地回环 HTTP/Unix socket 连回 commander 主进程**的一个内部端点,把请求转交、阻塞等回复。
- 工具入参 schema:`{tool_name, input, tool_use_id}`(实测 claude 就是这么传的,还带 `_meta.claudecode/toolUseId`)。返回 `content:[{type:'text', text: JSON.stringify(decision)}]`,`decision ∈ {behavior, updatedInput?, message?}`。

### 请求↔回灌配对（根因层纯函数,可测）

- 以 `tool_use_id` 为键维护「挂起的权限请求」表(server 侧),前端回 `{tool_use_id, decision}` 时按键 resolve。抽一个纯函数做「请求规整 + 决定校验」(如 deny 必须带 message、allow 才能带 updatedInput——与 hooks 文档约束一致),便于 `node:assert` 断言。

### 前端渲染（`TaskCard.jsx` / `parts.jsx`）

- 新增 ws 消息类型 `permission_request` / `permission_reply`(与既有 `converse` 通道并列)。
- 按 `tool_name` 分发渲染:
  - 普通工具 → 「工具名 + 入参摘要(复用 `toolSummary`)+ 允许/拒绝」
  - `AskUserQuestion` → 可选卡片(读 `input.questions[].options[]`,支持多选/Other/preview)
  - `ExitPlanMode` → 计划全文 + 批准/打回
- 焦点不抢走(遵 005):卡片出现不强制滚动/夺焦,只在当前批阅的会话面板内提示。

### 与 010 的关系

- 010 的「多轮历史沉淀」(`converse-fold.js`)保留复用。
- 010 的「skip 权限兜底」被本 spec 取代:默认不再 skip;保留「信任此会话」开关给不想被打扰的场景。

### 验证路径

- 先观测:用最小 MCP server 复现「approve 被调用 + deny 生效」(本 spec 背景里已做过一次,实现时回归)。
- 改后端 → `pkill + 重启 node`(模块缓存坑;worktree 用 `wt.sh restart`)。
- 端到端:面板续话触发一个 Write → 看审批卡片 → 点允许 → 文件创建;点拒绝 → 文件不创建、Claude 提示被拒。
- `AskUserQuestion`:构造一个会反问的续话 → 看可选卡片 → 作答 → 会话据答案继续。
- `pnpm test` + `pnpm build` 通过。

## 任务拆解

1. **实测固化**:把背景里的 ccr 透传探测沉淀成一个可重跑的脚本/测试夹具(确认机制在 CI/本机稳定)。
2. **内置 perm MCP server**:`src/server/perm-server.js` + 独立入口;`--mcp-config` 动态生成(指向该入口);与主进程的回环通道。
3. **主进程接线**:permission 请求 → ws `permission_request`;前端 `permission_reply` → resolve 挂起请求。请求表按 `tool_use_id` 配对 + 超时兜底(默认 deny)。
4. **converse.js 改造(进程模型)**:`-p` 短命 + `stdin.end()` → 长驻 stream-json 进程 + 持有 stdin + 按 `tool_use_id` 配对;加 `--input-format stream-json --mcp-config … --permission-prompt-tool …`。**放行派生自 cmdTemplate**:模板含 skip → perm 工具直接 allow(且 `--permission-mode` 沿用模板里的);模板不含 skip → `--permission-mode default` 走交互。生命周期/进程治理/`running` 保护重定义。
5. **前端渲染**:ws 类型 + 审批/澄清/计划三种卡片;复用 `toolSummary`/parts 风格;遵守 005 焦点约束。
6. **回归测试**:决定校验纯函数 + 请求配对 + 超时。
7. **文档同步**:`CLAUDE.md` 续话小节、`converse.js` 注释、本 spec 实现记录;更新 [[headless-session-no-tty]] 记忆(网页续话已能代答交互)。

## 风险 / 待定

- **perm server ↔ 主进程通道选型**:回环 HTTP / Unix socket / 命名管道。HTTP 最简单(commander 已是 HTTP server,加内部端点即可),但要防止该端点被外部访问(绑 127.0.0.1 + 随机 token)。**待定:实现时一次只验一种。**
- **`--mcp-config` 与用户已有 MCP 的叠加**:续话子进程注入我们的 perm server 时,不能覆盖用户全局/项目 MCP。需确认 `--mcp-config` 是追加还是替换(若替换,要先读取并合并)。
- **长驻进程治理**:每会话一个常驻进程,N 会话 N 进程——内存、僵尸进程、空闲回收、全局上限。这是本 spec 引入的新维度(现在没有),需认真做生命周期管理,否则长跑会泄漏进程。
- **stdin 回灌 race**:一轮还没结束(权限往返中)又收到用户新消息?需排队(本阶段回合制:未结束不接新消息,UI 禁用输入)或明确拒绝。
- **`--mcp-config` 与用户已有 MCP 的叠加**:注入 perm server 时不能覆盖用户全局/项目 MCP。确认是追加还是替换(若替换,先读取合并)。
- **已验掉的(不再是风险)**:长驻 stream-json + 权限工具 + ccr 三者共存——已实测跑通(见背景三块拼图),不必再赌。
- 安全:perm server 回环端点/token/绑定地址必须严控,不得让网络侧伪造「允许」;`autoApprove=true` 仅在本机受控可接受,网络暴露场景须强制走交互审批。

## L3:在本 spec 地基上的增量（另开 spec,预计 016+）

L1+L2 做完后,**进程模型(长驻)、stdin 回灌、权限/澄清通道都已就位**。L3 —「上朝面奏」式同步批阅(它说完你当场答、立即响应)—— 剩下的增量是:

1. **实时逐字流**:`--include-partial-messages`(或 stream-json 的 `content_block_delta`)→ ws → 前端逐字渲染,而非整轮 result 后才显示。
2. **同步守候 UI**:把回合制 UI 改成「守着等模型说完 → 输入框就地激活 → 连续往返」的编排;焦点/滚动随对话推进(在 005 约束下设计)。
3. **长驻进程的健壮性**:断线重连、进程崩溃后重建并 `--resume`、跨会话切换时的进程保活策略。

L3 **复用本 spec 的全部地基,不返工进程模型**——这正是本 spec 一步到位上长驻的目的。先做完 L1+L2、积累实战,再上 L3。

## 实现记录

**先观测（钉死全部不确定点，经 ccr）**：三块拼图 + skip 互斥实测均通过（见「背景」）。关键结论：长驻 stream-json + 权限工具 + ccr 三者共存；skip 模式下 perm 工具根本不被调用 → 实现按 cmdTemplate 是否含 skip 分两条路。

**落地文件**（worktree `feat/web-interactive-perm`，端口 3891）：
- `src/server/permission.js`（新）：纯函数 `normalizeDecision`（fail-closed 校验）/ `templateSkipsPermissions`（放行派生）/ `buildUserMessage`（stream-json 输入格式）。根因层，可单测。
- `src/server/perm-server.js`（新）：独立 stdio MCP server，暴露 `approve` 工具；收到调用经回环 HTTP POST 转交主进程并阻塞等回复；异常一律 deny（fail-closed）。零依赖手写 JSON-RPC。
- `src/server/perm-registry.js`（新）：主进程侧协调器。按 `tool_use_id` 挂起 Promise + ws 广播 `permission_request`；`resolvePermission` 落定；超时（5min）/ 会话回收 → deny。随机 token 校验。
- `src/server/converse.js`（重写）：`-p` 短命 → 长驻 stream-json 进程注册表 `procs`，持有 stdin，多轮共享上下文，空闲 10min 回收。`buildArgs` 按 cmdTemplate 派生放行：含 skip 不挂 perm 工具；不含 skip 挂 `--mcp-config`（动态生成指向 perm-server）+ `--permission-mode default --permission-prompt-tool mcp__commander__approve`。`running` 保护重定义为「非本进程持有 → 禁注入」。`startSession`（新建会话）仍用 `-p` 拿 sid 入队。保留 `saveUploads`/`extractSessionId`（测试依赖）。
- `src/server/index.js`：加 `POST /internal/permission`（token 校验，perm-server 长轮询）+ `POST /api/sessions/:sid/permission`（用户回灌）；listen 后 `setInternalUrl`。
- 前端 `App.jsx` 转发 `permission_request`/`permission_resolved` 给 `emitConverse`；`TaskCard.jsx` 新增 `perms` 状态 + `PermissionCard`（三类：普通工具审批 / `AskUserQuestion` 可选卡片 / `ExitPlanMode` 计划批准）+ `answerPerm` 回灌；`api.js` 加 `api.permission`；`styles.css` 加 `.perm-*`。

**验证**：
- 单测 `test/permission.test.mjs`（12 条）：决定 fail-closed、cmdTemplate 派生、stream-json 消息构造、配对/超时/会话回收。`pnpm test` 90/90、`pnpm build` 通过。
- perm-server 独立 JSON-RPC 端到端（假端点）：handshake→tools/call→POST→回传 decision，通过。
- 活服务端点冒烟（3891）：内部端点拒错 token(403)、回灌缺参(400)、未命中(matched:false)、queue(200)。
- **待人工浏览器端到端**：需一个 `cmdTemplate` 不含 skip 的会话触发真实工具 → 看审批/澄清卡片 → 点选 → 决定生效。（用户当前模板含 skip，按设计走全放行、不弹卡——这本身也是一条已验证路径。）

**偏差**：放行机制从初稿的「`autoApprove` 独立配置项」改为「派生自 cmdTemplate」（用户反馈：尊重用户已设的参数，模板带 skip 就该全放行）。回灌通道用 HTTP POST 而非 ws 入站（与项目既有动作一致，ws 保持纯广播）。
