# 009 — 队列语义修正 + 面板能力增强 + 空会话过滤

- **状态**: done
- **优先级**: 高
- **创建**: 2026-06-10
- **依赖**: [006](006-persistence.md)（同属「人工状态 vs 扫描复活」问题域，本 spec 落地其中的复活规则）

## 背景 / 动机

实测发现四个问题，已用证据钉死（`node -e` 读 `data/*.json`）：

1. **点「完成」后任务还会再出现**：16/16 个 `done` 任务的关联会话均未被压制，scanner 每 30s 扫到、`upsertFromAgent` 里 `done + waiting → 重新入队`，会话只要还活着就把 `done` 打回 `queued`。「完成」缺少「压住会话不再复活」的动作，与「移除」的差别没拉开。
2. **「稍后(defer)」与「跳过(skip)」语义重叠**：skip 是降权重排（仍在队列），defer 是定时隐藏（60min 内不出现），行为本已不同，但 UI 文案没讲清「会不会立刻消失」，且 defer 时长写死 60min 不可选。
3. **面板能力弱**：无「进入会话」入口（仅复制命令）；skipCount 只在卡片角落、无「一段时间跳过了多少」聚合；deferred 任务无处修改状态（提前唤回/直接完成）。
4. **空会话未过滤**：3/45 会话无真实内容；更该过滤的是「transcript 无任何真实 user 消息」的会话。

## 目标

修正队列调度语义，使 done/skip/defer/dismiss 四个动作「会不会再回来」清晰可预期；增强队列面板的可操作性；动态过滤空会话。**全部改动只动调度内核内部规则与前端，不触碰 Source/Renderer 边界（000 约束）。**

### 非目标

- 不引入数据库（延续 006，JSON + 原子写）。
- 不改 Source 插件契约、不为某来源加内核分支。
- 不做 skip/defer 的历史时间线可视化（仅做计数聚合）。

## 需求（用户已拍板的语义）

- **完成**：默认压住该任务，不再复活；**但若该会话之后产生全新的 `waiting`（hook 事件，说明又需要你），可重新冒出来**。（用户选项：「默认压住，但新 waiting 可复活」）
- **稍后**：保留「一段时间内从队列隐藏、到点自动回来」的本质，但 UI 给出**可选时长**（15min / 1h / 今晚 / 明天），deferred 列表显示「还有多久回来」并可**提前唤回 / 直接完成**。（用户选项：「保留隐藏+可选时长」）
- **跳过**：维持「降权重排到同档末尾、立即仍在队列」，与稍后区分开（文案明确）。
- **空会话**：transcript 无任何真实用户消息的会话不建隐式 task、不入队；**判定为动态——后续该会话有了真实用户消息，能重新被检测到并冒出来**（用户补充约束）。

## 验收标准

- [x] `done` 任务在 scanner 周期扫描下**不再被复活**（scan 的 idle/waiting 均不复活）。
- [x] `done` 任务在**收到该会话新的 `waiting` hook 事件**时**能复活**（对齐 dismiss 的复活条件）。
- [x] `dismiss`（移除）与 `done`（完成）复活条件一致，差别仅在语义/统计归类（dismiss 标记会话 dismissed；done 记入 history）。
- [x] 前端「稍后」按钮提供可选时长（15min/1h/今晚20:00/明早09:00）；deferred 列表项可「提前唤回」「直接完成」。
- [x] 队列面板显示「跳过次数」聚合（队列中累计 skippedTotal + 涉及任务数 skippedTasks）。
- [x] 队列面板/卡片提供「进入会话」入口（复制接续命令 + 点击工作目录复制路径）。
- [x] 无真实用户消息的会话不进队列；该会话后续有真实用户消息时能重新冒出（动态判定）。
- [x] 每条修复配回归断言，进 `test/tasks.test.mjs`：done 不被 scan 复活、done 被 waiting hook 复活、空会话动态过滤。
- [x] `pnpm build` 通过；`pnpm test` 23 绿；后端 `pkill + 重启` 后 curl 实测接口（浏览器 MCP 因 Chrome profile 占用受阻，前端纯函数 deferPresets 单独验算 + 构建产物核对）。

## 技术方案

### 问题 1：done 不被复活（根因层 = `tasks.js: upsertFromAgent`）

根因不在前端，在 `upsertFromAgent` 第 228 行的复活条件太宽（任何来源的 waiting 都复活）。改为：

```js
// done 任务只在「新 waiting 的 hook 事件」时复活；scan 不复活
if (task.status === 'done' && rec.liveState === 'waiting' && rec.source === 'hook') {
  task.status = 'queued'; task.queuedAt = now; task.completedAt = null
}
```

与 dismiss 的复活条件（`session.dismissed` 仅 `waiting + hook` 解除）统一。`done` 不需要再给会话打 `dismissed`——靠这条收紧的复活规则即可压住 scan，且语义上 done 会话仍属「正常会话」（区别于 dismiss）。

### 问题 4：空会话动态过滤（根因层 = `upsertFromAgent` 入口 + transcript 真实消息判定）

- 新增判定：会话是否有「真实用户消息」。复用 scanner 已有的 `cleanUserText`/`firstMsg` 思路与 `transcript.js`。轻量实现：`scanner.readMeta` 已解析 `firstMsg`（清洗过注入/系统前缀），把它透传进 `rec.hasRealUserMsg`（或直接以 `rec.summary` 是否来自真实 firstMsg 为准）。
- `upsertFromAgent`：当 `rec` 标明无真实用户消息**且该会话此前不存在/无隐式 task** 时，只更新/跳过，不建隐式 task、不入队。
- **动态性**：因为每次 scan 都会重新带上 `hasRealUserMsg`，一旦该会话出现真实用户消息，下一轮 scan 即建 task 冒出来——天然满足「后续有了能检测到」。

### 问题 2：defer 可选时长（前端为主，后端已支持 `minutes`）

- `deferTask(id, minutes)` 已支持任意分钟数，无需改后端。
- 前端 `MetaColumn`「稍后」改为带下拉/快捷档：15min / 1h / 今晚(到 20:00) / 明天(到次日 09:00)，换算成 minutes 调 `api.defer`。
- `Queue.jsx` deferred 行已显示 `deferLeft`；补「提前唤回」(调用 defer with 0 或新 `undefer`)「完成」按钮。

### 问题 3：面板能力（前端 `Queue.jsx` + `TaskCard.jsx`）

- deferred 行加操作按钮：唤回（清 deferUntil）、完成。唤回复用 `tickDefer` 逻辑：新增 `app.post /api/tasks/:id/undefer` → `task.deferUntil = null`。
- 跳过聚合：`buildQueue` 或 `buildOverview` 增加 `skippedTotal`（近 N 条/全部 skipCount 求和），面板顶部展示。
- 进入会话：MetaColumn 已有「复制接续命令」，补「打开目录」（`file://` 或仅展示路径，复制）。

### 不破坏调度内核的说明

以上全部是内核**内部规则**调整（复活条件、过滤条件、defer 时长参数）与前端操作，未新增任何 `source.type` 分支，符合 000 约束 1/2。

## 任务拆解

1. 写本 spec + 登记 README 索引。✅
2. **问题 1**：收紧 `upsertFromAgent` 的 done 复活条件 → 回归测试（scan 不复活 / waiting-hook 复活）。
3. **问题 4**：透传 `hasRealUserMsg`，`upsertFromAgent` 跳过空会话建 task → 回归测试（空会话不入队 / 有真实消息后入队）。
4. **问题 2**：前端 defer 可选时长；后端 `undefer` 路由 + api.js。
5. **问题 3**：Queue 面板 deferred 可操作 + 跳过聚合 + 进入会话入口。
6. `pnpm build` + `pkill/重启` + 浏览器实测，逐条勾验收。

## 风险 / 待定

- 「真实用户消息」判定若过严，可能误杀正常但首条是 slash 命令的会话——以 scanner 现有 `cleanUserText` 为准（已排除注入/命令包裹），保守起见无 firstMsg 才算空。
- 跳过聚合的时间窗口（近 N 条 vs 全部）待实现时定，先做「全部 skipCount 求和」最简版。

## 实现记录

落地于 2026-06-10。

**后端 `src/server/`**
- `tasks.js`：抽出纯函数 `shouldRevive(rec)`（done/dismissed 仅在 `waiting + hook` 复活）与 `isEmptySession(rec)`（`hasRealUserMsg === false` 判空，undefined 向后兼容不过滤）；`upsertFromAgent` 三处复活/过滤改用纯函数；新增 `undeferTask(id)`；`buildQueue` 返回 `skippedTotal/skippedTasks`。
- `scanner.js`：`scanOnce` 透传 `hasRealUserMsg = !!(meta.firstMsg || entry.summary)`（firstMsg 已由 `cleanUserText` 清洗注入/命令前缀）。
- `index.js`：新增 `POST /api/tasks/:id/undefer`。
- `events.js`：hook 来源不带 `hasRealUserMsg`（天然可信，不被空会话规则误杀）。

**前端 `src/client/`**
- `TaskCard.jsx`：`deferPresets()` 快捷档；「稍后」按钮改为展开档位；四个动作按钮加 title 说明「会不会再回来」；工作目录可点击复制。
- `Queue.jsx`：deferred 行加「唤回/完成」；顶部跳过聚合；行内 skipCount 角标。
- `api.js`：`undefer`。`App.jsx`：把 `api/act` 传入 `Queue`。`styles.css`：defer-presets / q-skip / q-skipsum / q-acts。

**测试**：`test/tasks.test.mjs` 8 条，钉死问题 1（scan waiting/idle 不复活、hook waiting 才复活）与问题 4（空会话动态过滤、向后兼容）。`pnpm test` 23 绿。

**与原方案偏差**：done 不再额外给会话打 dismissed 标记——靠收紧的 `shouldRevive` 已足够压住 scan，语义上保留「done 会话仍是正常会话」。「进入会话」未做 `file://` 打开（浏览器安全限制），改为复制路径。
