# Skill UI POC — 项目说明

## 核心理念

**一句话**：Agent 的输出不应该只是文本——Skill 可以连接已有的 Web App，在对话中用 rich UI 展示，而不是 dump 一堆 markdown。

**四种展示层形态**：

| 形态 | 说明 | 例子 |
|------|------|------|
| Generative | AI 临时生成 HTML | CSV 分析图表 |
| Hosted | Skill 作者维护的独立 Web 产品 | **Vibeflow Dashboard（本 POC）** |
| External | 第三方已有产品，Skill 做意图注入 | 麦当劳点餐、美团外卖 |
| Aggregated | 聚合多个 App 的数据，提供对比视图 | 全网比价、旅行规划 |

**Skill 的角色**：不是 UI 生产者，是**意图注入器** + **数据桥梁**。

详细思考过程见：`~/code/creo/lessnote/insights/Skill-UI-Layer-从文本到小程序的展示层革命.md`

---

## 当前状态

**POC 已跑通**：mock 数据 → HTML Dashboard → localhost 展示。

```
poc/
├── vibeflow-data.json   ← mock 数据（手写）
├── index.html           ← 单文件 Dashboard（Tailwind + Chart.js）
└── serve.sh             ← 启动 localhost:3721 并打开浏览器
```

运行：`./serve.sh` 或 `cd poc && python3 -m http.server 3721`

---

## 数据现状

当前 `vibeflow-data.json` 是**手写的 mock 数据**，不是真实数据。

真实数据在 Vibeflow 后端（PostgreSQL + tRPC），通过 MCP server 暴露了 27 个 tool + 15 个 resource。和 POC 相关的数据源：

| POC 展示项 | Vibeflow MCP 数据源 | 说明 |
|-----------|---------------------|------|
| 番茄进度 | `vibe://pomodoro/current` + `vibe://history/pomodoros` | 当前会话 + 7 天历史 |
| 任务列表 | `vibe://tasks/today` + `flow_get_top3` | 今日任务 + TOP 3 |
| Screen Time | `vibe://analytics/productivity` | 生产力分析（含 screen time） |
| 周趋势图 | `vibe://history/pomodoros` + `vibe://analytics/productivity` | 7 天聚合 |
| 系统状态 | `vibe://state/current` | IDLE/FOCUS/OVER_REST |

Vibeflow 后端地址：`http://39.105.213.147:4000`（tRPC API at `/api/trpc`）

---

## 下一步 Roadmap

### Phase 1：接真实数据（把 mock 换成 Vibeflow API）

**目标**：Dashboard 展示的是你真实的番茄/任务/screen time 数据。

**做法**：
1. 写一个 `fetch-data.sh`（或 .ts），调 Vibeflow tRPC API，输出 `vibeflow-data.json`
2. HTML 页面不用改（已经是读 JSON 渲染的）
3. 流程变成：`./fetch-data.sh && open http://localhost:3721`

**关键 API 调用**：
```
# 今日任务
GET /api/trpc/task.getTodayTasks

# 番茄历史
GET /api/trpc/pomodoro.getHistory?input={"days":7}

# 当前状态
GET /api/trpc/mcpBridge.getTaskContext

# 日报摘要
GET /api/trpc/mcpBridge.generateDailySummary
```

**预计工作量**：1-2 小时。数据格式需要做一次 mapping（Vibeflow schema → POC JSON schema）。

### Phase 2：Skill 集成（在 Claude Code 中一句话打开 Dashboard）

**目标**：在 Claude Code 对话中说 `/vibeflow dashboard` → 自动拉数据 + 打开 Dashboard。

**做法**：
1. 在 Vibeflow skill 中加一个 `dashboard` 子命令
2. Skill 调 MCP resource 获取数据 → 写入 JSON → 启动 server → 打开浏览器
3. ChatBot 中输出文本摘要（"今日 3/6 番茄，2 项待办"）+ Dashboard 自动弹出

**这就是"敲命令→弹看板"的完整闭环。**

### Phase 3：双向交互（在 Dashboard 中操作，数据回写 Vibeflow）

**目标**：在 Dashboard 里点"完成任务"→ 真的完成了（调 `flow_complete_task`）。

**做法**：
1. Dashboard 中的按钮通过 fetch POST 到本地 server
2. 本地 server 代理请求到 Vibeflow tRPC API
3. 操作完成后刷新数据

**这让 Dashboard 从"只读看板"变成"可操作的 mini-app"。**

### Phase 4：IM 容器（Dashboard 不再是独立浏览器窗口）

**目标**：Dashboard 内嵌在某个 IM 容器中，和对话并排显示。

**可选路径**：
- 嵌入 Commander TUI（Electron/Tauri webview）
- 嵌入现有 chat UI（LibreChat / LobeChat / Open WebUI 的 iframe）
- 独立做一个轻量 AI chat + webview 容器

**这是最大的工程决策点，到 Phase 3 跑通后再决定。**

---

## 技术栈选择

| 层 | 当前选择 | 理由 |
|----|---------|------|
| UI | Vanilla JS + Tailwind CDN + Chart.js | 零构建依赖，单文件，迭代最快 |
| 数据 | JSON 文件 | Skill → JSON → HTML，最简单的数据合约 |
| Server | Python http.server | 一行命令，不需要安装任何东西 |
| 真实数据 | Vibeflow tRPC API | 已有完整后端，不需要重建 |

**原则：不引入任何新依赖，直到当前工具链挡住了你。**

---

## 验证标准

每个 Phase 完成后问自己：

- **Phase 1**："看到自己真实的番茄数据渲染成图表，比在终端里看文本好多少？" → 如果答案是"好太多了"，继续。
- **Phase 2**："敲 `/vibeflow dashboard` 弹出看板的体验，比看文本输出好多少？" → 如果答案是"回不去了"，继续。
- **Phase 3**："在看板里直接操作，比切回终端打命令好多少？" → 如果答案是"明显好"，Phase 4 值得做。
- **Phase 4**：到时候再说。

**如果任何一步的答案是"其实差不多"，就停下来——说明文档里写的那些宏大架构是伪命题。**
