# 017 — 聚焦窗口（Focus Scope）：时间窗内只调度圈选的任务

- **状态**: accepted
- **优先级**: 中
- **作者**: yinshucheng
- **创建**: 2026-07-12
- **依赖**: 009（队列语义与面板）、000（架构基线）

## 背景 / 动机

现在的调度把**所有**在队列里的 task 一起排（`scheduler.rank()`），主轴是 liveState（谁在等你）。但用户常有「这段时间我只想处理某几件」的诉求——比如「接下来 2 小时只看 lessnote 和 open_agent 这两个项目的会话，别的都别来烦我」。

现有唯一的时间维度原语是 `defer`（`deferUntil`）：**单任务、正向推迟、到点自己复活**（「这个我待会再看」）。它无法表达「一批任务、反向排他、窗口内只放这批」（「这段时间我只看这些」）——要靠 defer 实现就得把其余几十个任务逐个 defer，不可行。

不做的话：用户无法在面板上进入「专注」状态，队列永远是全量按 liveState 冒泡，注意力被无关会话切走。

## 目标

一句话：**手动圈选一批 task（或按项目整选），设一个时长（如 2h），窗口生效期间队列/current 只呈现被圈选的任务；没圈选的默认隐藏，唯一例外是它变 `waiting`（真在等你/卡权限）时破例冒出来；到点自动失效，恢复常规全量调度。**

### 非目标

- **不做日历/作息表**（多个定时窗口按钟点自动切换）。只做「单个活跃窗口 + 选时长」。多窗口留作二期。
- **不做标签/分类圈定**。圈定方式只有「手动勾选 task / 按项目整选」。tag 体系是另一个特性。
- **不动排序键**。focus 是排序**之前**的一道过滤器，`rank()` 的六级比较键一个不改（架构基线：内核稳定、过滤可加）。
- **不做 session 粒度的圈选**。圈选按 **task**；「选项目」= 展开成该项目下所有 task。（session 属于 task，task 是调度单元。）

## 需求

作为使用者，我想要：

1. 在面板（Board）上勾选若干 task，或整选某个项目分组，点「🎯 聚焦 · 选时长」进入聚焦。
2. 进入后，队列与 current 只剩我圈选的任务；没圈选的消失。
3. 但如果某个没圈选的会话变成 `waiting`（模型停下来等我输入、或卡在权限审批），它要能破例冒出来——别因为专注而漏掉真正等我的事。
4. 顶部有个状态条：「🎯 聚焦中：N 个任务 · 剩 1h23m · [退出]」。
5. 到点自动失效，或我手动点退出，立刻恢复常规全量调度。
6. 同时只有一个活跃聚焦窗口；再次「聚焦」直接替换旧的。

## 验收标准

- [ ] 后端有 `focus` 全局状态：`{ taskIds: string[], until: number, createdAt: number }`，持久化在 `data/tasks.json` 顶层（随 `persist('tasks')` 落盘）。
- [ ] 纯函数 `inFocusScope(task, focus, now)`（`scheduler.js`）：无窗口/窗口过期→全放行；圈选的→放行；没圈选的→仅 `liveState==='waiting'` 放行，否则隐藏。**P0 不例外**（聚焦优先于 P0 硬置顶）。
- [ ] `rank(tasks, now, focus)` 在 `isQueued` 之后叠加 `inFocusScope` 过滤；排序键不变。
- [ ] `groupQueue` / `pickCurrent` / `buildQueue` / `buildCurrent` 把 `focus` 透传进 `rank`。
- [ ] `setFocus({taskIds, minutes})` / `clearFocus()`（`tasks.js`）改状态后走 `notifyChange()`（持久化 + ws 广播重排 + current 变了推 new_current）。
- [ ] `tickDefer`（或等价定时器）顺带检查 focus 过期：`focus.until <= now` 时清掉 focus 并 `notifyChange()`，让队列自动恢复全量。
- [ ] HTTP：`POST /api/focus {taskIds, minutes}` 设窗口；`DELETE /api/focus` 退出。`buildQueue` 的返回体带上 `focus`（含剩余时间供前端状态条）。
- [ ] 纯函数单测（`test/`）：圈选放行 / 没圈选隐藏 / 没圈选但 waiting 破例 / 窗口过期全放行 / 没圈选的 P0 也隐藏 / 空 focus 全放行。
- [ ] **阶段一 happy path**：用 `curl` POST focus 圈定 2 个 task → `GET /api/queue` 只剩这 2 个（+ 任何 waiting 的）→ 到点/`DELETE` 后恢复全量。跑通再进阶段二。
- [ ] **阶段二**：Board 多选模式 + 「🎯 聚焦」入口 + 顶部状态条 + 退出按钮；浏览器实测圈选后队列只剩圈选的、状态条倒计时、退出恢复。

## 技术方案

### 数据结构

`data/tasks.json` 顶层加 `focus`（与 `tasks[]` 平级）：

```jsonc
{
  "tasks": [ ... ],
  "focus": {
    "taskIds": ["t_xxx", "t_yyy"],
    "until": 1783900000000,   // now + minutes*60_000
    "createdAt": 1783892800000
  }
}
```

无聚焦时 `focus` 为 `null`。只存一个 → 满足「单个活跃窗口」，`setFocus` 直接覆盖。

### 过滤器（scheduler.js，核心且唯一的语义改动）

```js
// 聚焦窗口过滤：窗口生效(focus && focus.until > now)时——
//   圈选的 task 放行；没圈选的一律隐藏，【唯一例外】liveState==='waiting' 破例冒出来
//   （真在等你/卡权限，别因专注而漏）。P0 不例外——聚焦优先于 P0 硬置顶。
// 无窗口 / 已过期 → 全放行（等于没这功能）。纯函数，可单测。
export function inFocusScope(task, focus, now = Date.now()) {
  if (!focus || !focus.until || focus.until <= now) return true
  if (focus.taskIds?.includes(task.id)) return true
  return task.liveState === 'waiting'
}

export function rank(tasks, now = Date.now(), focus = null) {
  return tasks
    .filter((t) => isQueued(t, now))
    .filter((t) => inFocusScope(t, focus, now))   // ← 新增，排序键不动
    .sort(/* 六级键原样 */)
}
```

`pickCurrent` / `groupQueue` 签名加可选 `focus` 参数往下透传。`deferred` / `done` 分组**不过滤**（deferred 本就不在调度里；done 是历史）——focus 只约束「当前可调度集」。

### 状态操作（tasks.js）

```js
export function setFocus(taskIds = [], minutes = 120) {
  const data = getTasks()
  data.focus = { taskIds: [...taskIds], until: Date.now() + minutes*60_000, createdAt: Date.now() }
  notifyChange()
  return data.focus
}
export function clearFocus() {
  const data = getTasks()
  data.focus = null
  notifyChange()
}
```

`buildQueue`/`buildCurrent` 读 `getTasks().focus` 传给 `groupQueue`/`pickCurrent`。`buildQueue` 返回体加 `focus`（原样 + 前端自己算剩余）。

`tickDefer` 里加一句：`if (data.focus && data.focus.until <= now) { data.focus = null; changed = true }`，到点自动恢复。

> ⚠️ **注意 autoReviveIfEmpty 的相互作用**：若聚焦圈选的任务全部 done/defer，队列在 focus 过滤后可能「看起来空了」。`autoReviveIfEmpty` 判断的是 `isQueued`（不含 focus 过滤），所以它只会唤回 defer 的、不会误清 focus。但要测：聚焦期间圈选的任务全做完 → 队列应显示空（而非把没圈选的唤回），focus 仍在直到到点。这是「专注做完了，等窗口结束」的正常态。

### HTTP（index.js）

- `POST /api/focus` body `{taskIds, minutes}` → `setFocus` → 返回 focus。
- `DELETE /api/focus` → `clearFocus` → 204/ok。
- `buildQueue` 已把 focus 放进 `/api/queue` 响应。

### 前端（阶段二）

- `Board.jsx`：多选模式（勾选框 or 长按/框选），选中集 → 底部浮出「🎯 聚焦 N 个 · [时长下拉] · 开始」。项目分组头加「整选本组」。
- 顶部状态条（复用批阅视图那条 chip 行 or App 顶栏）：「🎯 聚焦中 · N 任务 · 剩 mm:ss · 退出」。倒计时前端本地算（`until - Date.now()`）。
- `api.js`：`setFocus(taskIds, minutes)` / `clearFocus()`。

## 任务拆解

**阶段一（后端 + happy path，先跑通）**

1. `scheduler.js`：加 `inFocusScope` 纯函数；`rank`/`pickCurrent`/`groupQueue` 加 `focus` 参数并透传。
2. `tasks.js`：`setFocus`/`clearFocus`；`buildQueue`/`buildCurrent` 读并透传 focus；返回体带 focus；`tickDefer` 加过期清理。
3. `index.js`：`POST /api/focus`、`DELETE /api/focus`。
4. `test/focus-scope.test.mjs`：6 条纯函数断言（见验收标准）。
5. **happy path 验证**：`curl` 设 focus → `/api/queue` 只剩圈选 + waiting → 到点/DELETE 恢复。`pnpm test` + `pnpm build` 通过。

**阶段二（前端）**

6. `api.js` 两个方法。
7. `Board.jsx` 多选 + 聚焦入口 + 整选项目组。
8. 顶部聚焦状态条 + 倒计时 + 退出。
9. 浏览器实测：圈选→队列只剩圈选的、waiting 破例、倒计时、退出恢复。

## 风险 / 待定

- **过期恢复的及时性**：靠 `tickDefer` 定时器（周期 tick）+ `inFocusScope` 里 `until<=now` 的惰性判定双保险——即便定时器还没跑，任何一次 `buildQueue` 都会因惰性判定把过期窗口视为「全放行」，不会卡住。
- **autoReviveIfEmpty 相互作用**：见技术方案里的 ⚠️，需专门一条测试覆盖「聚焦期圈选任务全做完 → 队列空但不唤回未圈选的」。
- **waiting 破例会不会太吵**：若聚焦期大量没圈选的会话变 waiting，专注被打破。先按方案做（不漏事优先），实测若太吵再考虑给状态条一个「连 waiting 也压住」的硬专注开关（二期）。
- **CLAUDE.md 文档同步**：阶段一落地时，在 `CLAUDE.md`「排序优先级」段补一句「rank 前先过 focus 过滤」，别让文档落后于代码。

## 实现记录

（完成后填）
