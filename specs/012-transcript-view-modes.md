# 012 — 批阅视图档位：全文 / 摘要 / 对话

- **状态**: accepted
- **优先级**: 中
- **创建**: 2026-06-11
- **依赖**: [001](001-structured-transcript.md)（结构化 parts 是本 spec 的渲染输入，本 spec 只在其上做展示层过滤/折叠，不改解析）

## 背景 / 动机

「像皇帝批阅奏章一样」管理多个会话——但当前 transcript 是一条**扁平、等权**的消息流：`user` / `assistant` / `tool` 三种角色，assistant 消息里再内嵌 `text / thinking / tool_use / todos`。实测体感：**工具调用（Bash/Read/Edit/Grep…）和 thinking 块占了绝大部分视觉体积**，而皇帝真正要批的「奏章核心」是——这个 AI 想干什么、做到哪了、现在卡在哪要我拍板。工具细节是「臣子的执行过程」，平时不必看，要查时再展开。

诉求原话：批阅时并不需要看到 AI 所有调用工具的消息（**但不要删除**），需要几种展示形态——把工具隐藏/简略，或只看用户几轮的核心信息。核心是「为奏章批阅提供更多有效信息」。

关键判断：后端 `getSessionContext` 已把每条消息拆成干净的结构化 `parts`（`kind ∈ text|thinking|tool_use|tool_result|todos`，且 `tool_result` 已配对挂到 `tool_use.result`）。因此这件事**可以纯前端做**——只在渲染层过滤/折叠，不动调度内核、不动 transcript 解析、不删任何数据。符合 `000-architecture.md`「调度内核稳定，内容来源/渲染可插拔」的基线。

## 目标

在 transcript 面板提供**三档信息密度递减**的「批阅视图」，让皇帝按需在「全看 / 看思路与结论 / 只看对话」之间切换。**不删除任何信息，只改渲染**；被隐藏的内容可临时召回。

三档定义：

| 档位 | text | thinking | tool_use / todos | 适用 |
|---|---|---|---|---|
| **全文 Full** | 显示 | 默认展开 | 全部按现状渲染（可折叠） | 深究执行细节 |
| **摘要 Digest** ⭐默认 | 显示 | **塌缩成一行**（💭 思考，可点开） | tool_use **塌缩成一行**（`✏️ 编辑 foo.js`、`❯ pnpm test`），不展开 body；todos 保留 | 日常批阅 |
| **对话 Talk** | 显示 | **并入占位组**（随工具一起藏，可展开） | tool **整组隐藏**，代以一条灰色**占位条**（`· 7 个工具调用`），点击临时展开该组 | 快速扫「它跟我说了啥 / 我说了啥」 |

已拍板的决策（与用户确认）：

- **默认档位 = Digest**：保留 AI 思路文本与收尾结论，压掉工具/思考过程噪音，最贴近「批阅奏章」。
- **全局共享一个开关**：所有卡片共用同一档位，记到 `localStorage`（纯展示偏好，不进 `~/.commander/config.json`）。切换一次处处生效。
- **Talk 档工具用占位条 + 可临时展开**：隐藏但不丢失、可召回，避免误以为「AI 啥也没干」。
- **thinking 在 Digest 折叠**：thinking 属「过程」，Digest 只保 text（奏章正文）与 todos；Full 档才默认展开 thinking。

### 非目标

- **不改后端**：不动 `getSessionContext`、不改分页（仍一次取 10 条、上滑加载更早）。三档都只是前端把已取到的 `msgs` 过滤/折叠。
- **不删数据、不改 parts 结构**：`recentMessages` 原样返回，档位只决定怎么画。
- **不做 LLM 二次摘要**：Digest 的「一行摘要」是规则生成（工具名 + 关键入参），不调模型。LLM 总结另案（若需要）。
- **不为某 Source 加分支**：档位逻辑只作用于 `claude` 结构化渲染；`codex`/`web` 占位不受影响。

## 验收标准

- [ ] transcript 面板头部（`ctx-recent-head` 右侧）有三段式切换器 `全文 | 摘要 | 对话`，当前档位高亮。
- [ ] 首次打开默认停在 **Digest**；切换后刷新页面/切换卡片仍保持上次选择（localStorage 持久）。
- [ ] 切档是**全局**的：在 A 卡切到 Talk，切到 B 卡仍是 Talk。
- [ ] **Full**：渲染与现状完全一致（thinking 默认展开、工具可折叠、diff/bash/file 各自卡片）。
- [ ] **Digest**：
  - text part 正常 markdown 渲染；
  - thinking part 塌成一行（`💭 思考`），点击展开全文；
  - tool_use 塌成**单行摘要**（图标 + 中文动词 + 关键入参，如 `✏️ 编辑 transcript.js`、`❯ pnpm test`、`📄 读取 App.jsx`），**不展开 body**；点击该行可临时展开完整工具卡片；
  - 出错的工具（`result.isError`）单行标红，便于一眼看到失败；
  - todos 清单保留完整显示。
- [ ] **Talk**：
  - 只显示 user 消息、assistant 的 text part、todos；
  - **连续的 tool_use（含被吸收的 tool_result）与 thinking 一并归入占位组**，收成一条占位条 `· N 个工具调用`，点击临时展开该组的完整内容（工具卡片 + thinking 全文）；
  - 占位条若该组含出错工具，标记 `· N 个工具调用（含失败）` 标红。
- [ ] **不丢消息**：Talk 档把纯工具消息（`role === 'tool'` 且无 text）藏进占位，但「历史 N / 共 M 条」的计数仍按后端 `total`，上滑加载更早照常工作。
- [ ] 续话流式回复（streaming assistant）在任何档位都正常显示（它本就是纯 text）。
- [ ] `pnpm build` 通过；浏览器实测三档切换；为「档位过滤纯函数」补一条回归测试（见技术方案）。

## 技术方案

**纯前端，分两块：一个可测的过滤纯函数 + 渲染层消费它。**

### 1. 过滤纯函数（可单测）—— `src/client/view-mode.js`（新增）

把「档位 → 这条消息该怎么画」抽成纯函数，脱离 React 便于 `node --test` 断言。

```js
// 档位常量
export const VIEW_MODES = ['full', 'digest', 'talk']
export const DEFAULT_MODE = 'digest'

// 输入：原始 msgs（含 parts），输出：渲染指令数组
// 每个元素 { type: 'msg', msg, partModes } 或 { type: 'tool-group', parts, hasError }
//   partModes: 与 msg.parts 等长，每项 ∈ 'show' | 'collapse'（thinking/tool 折成一行）
// talk 档把连续工具消息合并成 tool-group 占位；full/digest 不合并。
export function planView(msgs, mode) { /* … */ }

// 单条 tool_use → 一行摘要文本（图标 + 动词 + 关键入参）
export function toolSummary(part) { /* 复用 parts.jsx 的 FILE_TOOL_META/动词表 */ }
```

- `full`：每条 msg 原样，`partModes` 全 `show`（thinking 也 show → 沿用 ThinkingPart 的 Collapsible 默认行为）。
- `digest`：thinking、tool_use 标 `collapse`；text、todos 标 `show`。`collapse` 由渲染层画成单行可展开。
- `talk`：扫描 msgs，把 `role === 'tool'` 的消息、以及 assistant 里的 tool_use **和 thinking** parts，归并成 `tool-group`；user / assistant-text / todos 保留为 `msg`。（thinking 不再单独留一行，跟工具一起藏进占位，展开后可见全文。）

**测试**（`test/view-mode.test.mjs`，核心不变量）：
- 构造含 text+thinking+3 个 tool_use + todos 的 msgs；
- 断言 `planView(msgs, 'talk')` 不丢任何 part（展开 tool-group 后 part 总数 == 原始 part 总数）——**「隐藏不删除」是本 spec 的核心不变量**；
- 断言 `digest` 下 thinking/tool 标 `collapse`、text/todos 标 `show`；
- 断言 `toolSummary` 对 Bash/Edit/Read 产出含正确动词与入参的单行。

### 2. 渲染层 —— `src/client/TaskCard.jsx` + `src/client/parts.jsx`

- **切换器**：`ContextView` 顶部 `ctx-recent-head` 右侧加 segmented control。档位状态提到一个**全局来源**：用一个轻量 hook `useViewMode()`（读写 `localStorage['commander.viewMode']`，跨卡片共享）。切换 → `setMode` → 触发重渲染。
- **消费 plan**：`msgs.map` 改为 `planView(msgs, mode).map`，按指令分发：
  - `type:'msg'`：遍历 `partModes`，`show` 走现有 `<MessagePart>`；`collapse` 走新的单行组件。
  - `type:'tool-group'`（仅 talk）：画占位条，本地 `useState(open)` 控制临时展开，展开后渲染组内各 `<MessagePart>`。
- **单行折叠组件**（`parts.jsx` 新增 `<CollapsedPart part>`）：thinking → `💭 思考`；tool_use → `toolSummary(part)`。点击 `open` 后内联渲染对应的完整 `<MessagePart>`（thinking 全文 / 工具卡片）。出错工具加 `err` accent。
- `parts.jsx` 复用现有 `FILE_TOOL_META`、diff/bash/file 组件，不重写；`toolSummary` 抽取其图标/动词表（避免重复硬编码）。

### 为什么不放后端 / 不进 config

- 后端 `parts` 已经够干净，过滤是**纯展示决策**，放前端避免增加 `getSessionContext` 的形态分支（保住 001 的单一职责）。
- 档位是个人即时偏好、切换频繁，`localStorage` 比 `~/.commander/config.json` 合适（后者是跨设备/需服务端读的配置，档位不需要）。

## 任务拆解

1. 新增 `src/client/view-mode.js`：`VIEW_MODES` / `DEFAULT_MODE` / `planView` / `toolSummary`（纯函数，从 `parts.jsx` 抽动词/图标表共用）。
2. 新增 `test/view-mode.test.mjs`：核心不变量「Talk 档不丢 part」+ digest 折叠标记 + toolSummary 三例。`pnpm test` 通过。
3. `parts.jsx`：导出 `FILE_TOOL_META` 等共用元数据；新增 `<CollapsedPart>`（thinking/tool 单行可展开）。
4. `TaskCard.jsx`：`useViewMode()` 全局 hook；`ctx-recent-head` 加 segmented control；`ContextView` 消费 `planView` 渲染（含 tool-group 占位条临时展开）。
5. `styles.css`：segmented control、`CollapsedPart` 单行、tool-group 占位条样式（灰、低调、hover 可点）。
6. 验证：`pnpm build` → 浏览器三档切换实测（含出错工具标红、上滑加载、续话流式）。

## 实现记录

落地文件：
- `src/client/view-mode.js`（新）：`VIEW_MODES`/`DEFAULT_MODE`/`VIEW_MODE_LABEL`/`planView`/`toolSummary`。纯函数，无 React 依赖。
- `test/view-mode.test.mjs`（新）：6 条断言，含核心不变量「Talk 档展开占位组后 part 唯一覆盖数 == 原始」。
- `src/client/parts.jsx`：新增 `CollapsedPart`（thinking/tool 单行可展开），引入 `toolSummary`。
- `src/client/TaskCard.jsx`：`useViewMode()` 全局 hook（localStorage `commander.viewMode` + 监听者集合广播跨卡同步）；`ctx-recent-head` 加 segmented control；`ContextView` 渲染改为消费 `planView`；新增 `ToolGroup` 占位条组件。
- `src/client/styles.css`：`.view-seg`/`.collapsed-line`/`.tool-group-bar` 样式。

实测结论（观测驱动）：
- 真实会话（30 条消息）跑 `planView` 三档：full/digest 30 节点 0 占位组，talk 收成 17 节点 + 8 占位组，**三档唯一覆盖 part 数均 == 30，零丢失**（`node -e` 直接对 `getSessionContext` 输出验证）。
- `pnpm test` 61/61 通过；`pnpm build` 通过；server 已在服务最新 bundle。
- 浏览器可视化最终态由用户实测确认（chrome-devtools MCP 因 profile 占用未能自动接管）。

### 对抗式审查修正（2026-06-11）

对抗式审查发现初版 talk 分支两个真 bug，已复现并修复：
- **BUG-1（严重·因果错乱）**：消息内 `text→tool_use→text` 交错时，工具被甩到所有文本之后（皇帝看到「读完发现问题」却在上方看不到工具）。
- **BUG-2（违反验收）**：跨消息的连续工具/thinking 没合并成一条占位条，被拆成多条碎片。
- **同源根因**：初版 talk 把 `msg` 当不可分割整体入列，占位组只能挂在 msg 前后，撑不起 spec 要的「part 粒度、跨消息连续归并」。
- **修法**：`view-mode.js` talk 分支重写为 **part 粒度线性扫描**——逐 part 判可见/入组，严格保序；占位组累积跨消息直到下一个可见 part 才 flush。talk `msg` 节点改为自带可见 part 子集（`item.parts` + `item.role`），渲染层 `TaskCard.jsx` 相应适配。顺带消除了未文档化的 `'hide'` partMode（审查 ⚪ 项）。
- **测试补强**（审查指出 Set 去重无序、测不出错位）：新增 `renderOrder` 线性序列断言（BUG-1）、跨消息合并断言（BUG-2）、「每个 part 恰好渲染一次」带重数断言（防丢失也防重复）。`test/view-mode.test.mjs` 9 条。
- **验证**：真实会话（30 parts）三档均「恰好一次、零丢失零重复」；`pnpm test` 64/64；`pnpm build` 通过。
