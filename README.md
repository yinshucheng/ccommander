# Commander ⚡

AI 多实例实时指挥台 — 像皇帝批阅奏章一样管理你的 AI 工作流。

## 解决什么问题

你同时开着 5+ 个 Claude Code 会话，分别在不同项目上干活。一个完成了、两个在等你审批、还有一个跑了 10 分钟没动静。你不知道该先处理哪个，也不知道哪个已经等了很久。

Commander 把所有 AI 实例的状态汇总到一个面板，让你：
- 一眼看到全局：谁在跑、谁在等、等了多久
- 逐条批阅：像处理消息队列一样连续处理待办
- 一键跳转：处理完直接跳到对应项目窗口

## 架构

```
┌─────────────────────────────────┐
│        Commander TUI            │  ← 终端界面
│  实时面板 + 队列 + 一键跳转      │
├─────────────────────────────────┤
│        事件总线（JSONL）          │  ← 核心，不依赖外部
├──────────┬──────────────────────┤
│ 采集插件  │   丰富插件（可选）    │
│ Claude   │ Vibeflow → 目标绑定  │
│ Code     │ GitHub → PR 关联     │
│ Cursor   │ ...                  │
└──────────┴──────────────────────┘
```

## 不依赖 Vibeflow

Commander 独立运行。装一个 hook，开一个面板，就有完整的批阅奏章体验。
接上 Vibeflow 后多一层目标绑定——看到的不是"某个 Claude Code 完成了"，而是"小红书项目又推进了一步"。

## 快速开始（V1 已实现）

需要 Node.js ≥ 20、pnpm。

```bash
pnpm install
./start.sh                # 自动构建 + 装 hook + 起服务 + 开浏览器（一步到位）
```

老手可用开关精确控制：

```bash
./start.sh --port 4000 --no-open --no-install-hooks
./start.sh --help         # 全部开关
```

> Windows 暂无 `start.sh`，用：`pnpm build && node bin/commander.js install-hooks && node bin/commander.js serve`

**续话命令**：默认走原生 `claude --dangerously-skip-permissions --resume {sessionId}`。
若你用 [claude-code-router](https://github.com/musistudio/claude-code-router)，在 Settings 把 `cmdTemplate` 改成
`ccr code --dangerously-skip-permissions --resume {sessionId}` 即可（也可直接编辑 `~/.commander/config.json`）。
启动日志会自检 `claude`/`ccr` 是否在 PATH 并告诉你续话将用哪个命令。

- **会话自动冒出来**：你机器上正在跑的 Claude Code 会话，完成/等待时自动出现在面板
- **三键批阅**：`Enter` 完成 · `S` 跳过 · `L` 稍后 · `D` 移除，处理完下一个自动弹出
- **零侵入兜底**：即使不装 hook，启动时也会扫描 `~/.claude/projects` 列出近期会话
- **状态语义**：🟡 可能在等你 / 🔵 在跑 / ⚪ 静默 / ✓ 已完成

实现细节见 [INTEGRATION.md](./INTEGRATION.md)（整合设计）与 [PLAN_COMMANDER.md](./PLAN_COMMANDER.md)（实现计划）。

## V1 架构（已落地）

```
浏览器面板 (React+Vite)  ──ws──  Node server (Express+ws)
                                   ├── events.js   消费 ~/.commander/events.jsonl（hook 推送）
                                   ├── scanner.js  扫 ~/.claude/projects JSONL（兜底发现）
                                   ├── ingest      会话 → 自动建隐式 task → 入队
                                   ├── scheduler   waiting > completed > running > idle 排序
                                   └── JSON 持久化  data/{tasks,sessions,history}.json
         ▲
hooks/commander-emit.sh  ←  Claude Code Stop/Notification/SessionStart hook（复用 parse-hook.py）
```

> **状态准确度自知**：hook 触发的 waiting/completed ~95%+；纯扫描兜底的 waiting ~70%（漏报为主）。
> 装 hook 后状态自动精确化。
