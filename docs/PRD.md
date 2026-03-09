# Commander MVP — 产品需求文档

## 一句话定义

终端实时指挥台，汇总所有 AI 实例状态，支持逐条批阅和一键跳转。

---

## 核心用户场景

### 场景 1：多实例并行，不知道该看哪个

> 我开了 5 个 Claude Code，分别在 lessnote、vibeflow、flash-playground、data-agent、magic-bar 上干活。
> 我在写文档，突然想看看 AI 们的进展。打开 Commander，一眼看到：
> - vibeflow: ✅ 完成（2分钟前）— "修复 iOS Screen Time 权限问题"
> - lessnote: ⏳ 等待输入（等了 3 分钟）— "hook优化"
> - flash-playground: 🔄 运行中（已跑 8 分钟）— "前端样式调整"
> - data-agent: ✅ 完成（刚刚）— "SQL 查询优化"
> - magic-bar: 🔄 运行中（已跑 1 分钟）— "数字人对话逻辑"
>
> 我按回车，跳到 lessnote 的 CatPaw 窗口处理等待的请求。处理完，Commander 自动弹出下一条。

### 场景 2：长时间运行，不确定是卡了还是在跑

> flash-playground 已经跑了 15 分钟没动静。Commander 显示"🔄 运行中 15m"，我一看就知道可能卡了，直接跳过去检查。

### 场景 3：一天结束，回顾 AI 帮我干了什么

> Commander 显示今天的统计：12 个任务完成，跨 4 个项目。

---

## MVP 功能清单

### P0：必须有（MVP 核心）

#### 1. 事件采集
- [ ] Claude Code hook 写事件到 `~/.commander/events.jsonl`
- [ ] 事件类型：`started` / `completed` / `waiting` / `error`
- [ ] 每条事件包含：timestamp、session_id、project_root、project_name、session_name、event_type、message

#### 2. TUI 实时面板
- [ ] 实时显示所有 AI 会话的当前状态
- [ ] 每行显示：状态图标 + 项目名 + 会话描述 + 持续时间/等待时间
- [ ] 按状态排序：等待中 > 已完成（未处理）> 运行中
- [ ] 自动刷新（watch events.jsonl）

#### 3. 批阅操作
- [ ] 选中一条按回车：跳转到对应项目窗口（catpaw/vscode）
- [ ] 标记为已处理（从队列移除）
- [ ] 支持键盘快捷键：j/k 上下移动，Enter 跳转，d 标记已处理

### P1：很想要（MVP 后第一批）

- [ ] 统计视图：今天完成了多少任务，跨几个项目
- [ ] 声音提醒：新事件到来时播放音效（复用现有红警音效）
- [ ] Vibeflow 集成：事件关联到 Vibeflow 项目/目标

### P2：锦上添花

- [ ] 菜单栏 app 版本（macOS native）
- [ ] 支持 Cursor、Copilot 等其他 AI 工具的事件采集
- [ ] Web UI 版本

---

## 技术方案

### 事件格式（JSONL）

```jsonl
{"ts":"2026-03-09T14:30:00Z","type":"started","session_id":"abc123","project_root":"/Users/x/code/creo/vibeflow","project_name":"vibeflow","session_name":"修复iOS权限","message":""}
{"ts":"2026-03-09T14:35:00Z","type":"completed","session_id":"abc123","project_root":"/Users/x/code/creo/vibeflow","project_name":"vibeflow","session_name":"修复iOS权限","message":"已完成所有修改并提交"}
{"ts":"2026-03-09T14:36:00Z","type":"waiting","session_id":"def456","project_root":"/Users/x/code/creo/lessnote","project_name":"lessnote","session_name":"hook优化","message":"需要确认通知方案"}
```

### 状态机

```
started → running（推断，无显式事件）
       → completed
       → waiting（需要用户输入）
       → error
```

运行状态通过"有 started 但没有后续 completed/waiting"推断。

### 技术栈

- **事件总线**：JSONL 文件（`~/.commander/events.jsonl`），最简单可靠
- **TUI**：Node.js + Ink（React for CLI）或 Python + Textual
- **采集端**：修改现有 Claude Code hook 脚本，额外写一行到 events.jsonl
- **跳转**：复用现有 `catpaw <dir>` 逻辑

### 改动量

1. **修改 `notify-done.sh` / `notify-waiting.sh`**：追加事件到 events.jsonl（约 5 行代码）
2. **新增 `SessionStart` hook**：记录 `started` 事件
3. **新建 TUI 应用**：核心是一个 watch + render 循环

---

## 非目标（MVP 不做）

- 不做跨机器同步
- 不做 Web 版
- 不做复杂的权限/多用户
- 不接入非 Claude Code 的 AI 工具
- 不做历史回放/时间线

---

## 成功标准

MVP 成功 = **我自己每天都在用它来切换 AI 会话，而不是手动在 CatPaw 标签页之间翻找。**
