# 008 — TaskCard 两栏布局：左历史 / 右元信息+操作

- **状态**: accepted
- **优先级**: 中
- **作者**: yinshucheng
- **创建**: 2026-06-10
- **依赖**: 001（结构化 transcript）

## 背景 / 动机

当前 TaskCard 是 760px 单列，从上到下：标题 → meta → session 信息 → transcript（70vh 滚动区）→ 续话输入框 → 操作按钮。

把历史区加到 70vh 后，整张卡片高达 ~1210px，超过视口（~794px）。`.stage` 居中布局把卡片上下溢出 —— **续话输入框被挤到视口底部之外，实测只露出顶部 ~16px，肉眼等于消失**（observed: `converse` rect top=778 / bottom=895，viewport=794）。这是回归 bug，也暴露了单列布局的根本局限：垂直空间不够同时放「高历史区 + 输入框 + 操作」。

## 目标

TaskCard 改为两栏：**左栏纯历史记录（transcript 可无限上滑 + 输入框固定底部）**，**右栏集中该 session 的所有元信息 + 操作按钮**。右栏新增展示：会话启动时间、对话总轮次、未压缩轮次。

### 非目标

- 不动调度内核（scheduler/tasks/store）、不动 events/scanner 数据源。
- 不改 transcript 解析逻辑（parts 配对等），只在 `getSessionContext` 返回里**追加**三个统计字段。
- 不做多 session tab 的重新设计（沿用现有 SessionPanel 的 tab 逻辑，只是搬位置）。

## 需求

- 左栏：transcript 历史（自动上滑加载，沿用现有逻辑）+ 续话输入框固定在左栏底部，始终可见。
- 右栏（固定宽度，默认 320px）：
  - 状态 badge（liveState）+ 优先级 badge
  - **启动时间**（会话首条带 ts 的事件）
  - **对话总轮次**（真实用户消息轮数，与 transcript 口径一致：排除注入噪音/纯工具返回）
  - **未压缩轮次**（最后一次 compact 之后的用户轮数；无 compact 则 = 总轮次）
  - 等待时长 / 项目 / 分支 / 活动时间 / 跳过次数（原 meta 内容）
  - 目录
  - 「📋 复制接续命令」按钮（命令默认折叠，点击复制；不再整行平铺长命令）
  - 分隔线
  - 操作按钮：完成 / 跳过 / 稍后 / 移除（竖向排列，带快捷键 kbd）
- 卡片铺满 `.stage` 可用宽度（减边距）。
- 左右栏之间有**可拖拽分隔条**调节宽度（满足「消息展示宽度可调」），位置记忆到 localStorage。

## 验收标准

- [x] 续话输入框在视口内可见（`converse` rect.bottom ≤ viewport 高度），不再被挤出屏幕。（实测 bottom=717 ≤ 794）
- [x] 两栏布局：左栏 transcript + 输入框，右栏元信息 + 操作，桌面宽度下并列。
- [x] 右栏显示「启动时间 / 总轮次 / 未压缩轮次」，数值与后端 jsonl 实际一致（含 compact 会话核对：user=249 / uncompacted=44 / compact=3）。
- [x] 接续命令折叠为「📋 复制接续命令」按钮，点击写入剪贴板。
- [x] 拖拽分隔条能改变左右栏宽度；刷新后宽度保持（localStorage：拖拽生效并持久化，刷新恢复 320）。
- [x] transcript 自动上滑加载、滚动锚点保持（spec 已有功能）不回归。（实测 10→20 条，scrollTop 锚点保持）
- [ ] 操作按钮快捷键（Enter/S/L/D）仍生效。（未改 App.jsx 键盘逻辑，按钮 onClick 不变；未单独回归实测）
- [x] 后端新增 3 字段配回归测试（启动时间存在、未压缩轮次 ≤ 总轮次、有 compact 时未压缩 < 总）。test 11/11 绿。

## 技术方案

### 后端：`getSessionContext` 追加统计字段（src/server/transcript.js）

在现有单遍解析里顺带统计（不新增文件读取）：

- `startedAt`：第一个带 `timestamp` 的事件的 ts（毫秒或 ISO 原样返回，前端格式化）。
- `userTurns`：`filtered` 中 `role === 'user'` 的消息数（已排除 tool 返回与噪音，口径与 transcript 一致）。
- `uncompactedTurns`：最后一个 `isCompactSummary === true` 事件**之后**的 user 轮数。需在解析时记录每条 user 消息对应的原始行是否在最后一个 compact 边界之后。
  - 实现：第一遍扫描时记录 `lastCompactSeq`（最后一次 `isCompactSummary` 命中时 `filtered` 的当前长度位置），结束后 `uncompactedTurns = filtered.slice(lastCompactIdx).filter(role==='user').length`；无 compact 则 = `userTurns`。

这些字段对 `recentMessages` / 分页契约**零影响**，纯增量返回。

### 前端：状态提升 + 两栏骨架（src/client/TaskCard.jsx）

**数据流**：把 context 的 fetch + ctx state 从 `ContextView` 提升到 `TaskCard`（或新建一个容器组件），让左栏（transcript+输入）和右栏（指标）共享同一份 ctx，避免重复请求、保证一致。

- `TaskCard` 渲染 `.task-card.two-col`：
  - 左栏 `.col-history`：flex 列，内含 transcript 滚动区（`flex:1; min-height:0`）+ 输入框（`flex-shrink:0` 固定底部）。
  - 拖拽手柄 `.col-resizer`。
  - 右栏 `.col-meta`：badge / 指标 / 目录 / 复制命令按钮 / 分隔 / 操作按钮。
- transcript + 续话逻辑（ContextView 现有的 msgs/loadMore/onScroll/converse 状态）保留在左栏组件里，**不拆散**，只是把 ctx 的首次 fetch 上提；指标字段（startedAt/userTurns/uncompactedTurns）从上提的 ctx 传给右栏。

> 取舍：也可不提升状态，用回调把 ctx meta 上报给 TaskCard。选「提升 fetch」因为两栏都依赖 ctx，单一数据源更清晰，且省一次请求。

### 拖拽分隔条

- 鼠标按下手柄 → 监听 `mousemove` 改右栏宽度（clamp 240–520px）→ `mouseup` 落 localStorage（key 如 `commander.metaColWidth`）。
- 纯前端、纯 CSS 变量驱动（`--meta-w`），不引依赖。

### CSS（src/client/styles.css）

- `.task-card` 改 `width: min(1280px, 100%)`、`display:flex`。
- 左栏 flex:1、列布局、`min-width:0`（防 transcript 撑破）。
- 输入框 `.converse` 固定在左栏底部（左栏 flex 列 + transcript 区 flex:1 滚动）。
- 右栏固定 `width: var(--meta-w, 320px)`、`overflow:auto`。
- `.ctx-scroll` 的 `max-height:70vh` 改为 `flex:1; min-height:0`（在左栏 flex 列里自然撑满，不再用固定 vh）。

## 任务拆解

1. 后端 `getSessionContext` 加 `startedAt` / `userTurns` / `uncompactedTurns`，`node -e` 对含 compact 会话核对数值。
2. 写后端回归测试（test/transcript.test.mjs 追加）。
3. 前端：ctx fetch 提升到 TaskCard，拆 `HistoryColumn`（左）/ `MetaColumn`（右）两个组件。
4. 左栏 flex 列布局：transcript 滚动区 flex:1 + 输入框固定底部 —— 验证输入框回到视口内。
5. 右栏：badge + 三指标 + meta + 目录 + 复制命令按钮 + 操作按钮。
6. 拖拽分隔条 + localStorage 宽度记忆。
7. CSS 两栏 + 滚动区改 flex。
8. 浏览器实测全部验收标准。

## 风险 / 待定

- **窄屏**：两栏在窄视口会挤。本期默认桌面使用；可加 `@media (max-width: 900px)` 回退为单列堆叠（右栏在下）。先做桌面，窄屏回退作为 stretch。
- **未压缩轮次语义**：定义为「最后一次 compact 之后的 user 轮数」。若一个会话多次 compact，只算最后一段——符合「当前上下文里没被压缩掉的对话」直觉。已与用户口径对齐。
- 状态提升涉及 ContextView 较大改动，注意不要弄回归自动上滑加载（spec 已有功能）。

## 实现记录

落地（2026-06-10）：

- **后端** `src/server/transcript.js`：`getSessionContext` 单遍解析里追加 `startedAt`（首个带 ts 事件）、`userTurns`（filtered 中 role=user 数）、`uncompactedTurns`（最后一代 compactGen 的 user 数）、`compactCount`。`compactGen` 是内部字段，slice 时剥离不外泄。分页契约零影响。
- **测试** `test/transcript.test.mjs`：加 `findCompactedSession`/`findAnySession` + 4 条断言（字段齐备且不泄漏 compactGen、uncompacted≤user、无 compact 时相等、有 compact 时严格小于）。`pnpm test` 11/11 绿。
- **前端** `src/client/TaskCard.jsx`：
  - 不提升整个 fetch（避免大改 ContextView 回归自动上滑加载），改为 `ContextView` 新增 `onCtx` 回调上报 ctx，右栏用这份数据。`SourceView` 透传 `onCtx`。
  - 删 `SessionPanel`，逻辑并入 `TaskCard`：两栏 flex 骨架（`.col-history` / `.col-resizer` / `.col-meta`），session tab 提到左栏头部。
  - 新增 `MetaColumn`（右栏）：badge + 统计（启动/对话轮次/未压缩）+ meta（等待/活动/项目/分支/跳过）+ 目录 + 「📋 复制接续命令」+ 操作按钮竖排。
  - 拖拽：`onResizeStart` 监听 window mousemove/up，改 `--meta-w`（clamp 240–560），mouseup 落 localStorage（`commander.metaColWidth`）。
  - 加 `datetime()` 格式化 ISO 启动时间。
- **CSS** `src/client/styles.css`：`.task-card.two-col` flex 两栏、高度 `calc(100vh - …)`；`.ctx`/`.ctx-recent`/`.ctx-scroll` 改 `flex:1; min-height:0`（从固定 `max-height:70vh` 改为撑满左栏剩余高度）——**这是输入框消失 bug 的根因修复**：单列时卡片撑到 1210px 把输入框挤出 794px 视口，两栏 + flex 滚动区后输入框固定左栏底部、始终可见（实测 bottom 895→717）。`.converse`/`.ctx-first` 加 `flex-shrink:0`。

与原方案偏差：未做拖拽手柄方向的「往左拖→右栏变宽」之外的窄屏 `@media` 回退（spec 列为 stretch，未实现）。操作按钮快捷键未单独回归实测（onClick 与 App.jsx 键盘逻辑均未改动）。
