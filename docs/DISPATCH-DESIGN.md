# Dispatch — 个人任务调度系统

> 你是皇帝，不是秘书。任务来找你，不是你找任务。

## 1. 问题定义

### 1.1 现状

- 同时运行多个 agent session（Claude Code / Codex / CatDesk），通过 cmux 管理
- 多个 session 并发执行，完成时间不可预测
- 你是单线程的：同一时刻只能专注一件事

### 1.2 痛点

| 问题 | 表现 |
|------|------|
| 饥饿 | 某些 session 早已完成，等你输入，但你在忙别的，它空转数小时 |
| 轮询 | 你反复切换窗口检查"谁做完了"，打断了深度思考 |
| 调度成本 | 你花大量时间决定"接下来做什么"而不是"做事本身" |
| 上下文丢失 | 切到一个等了很久的 session，忘了当时要干嘛 |

### 1.3 目标

- **消灭调度时间**：你永远不需要想"接下来做什么"，系统告诉你
- **消灭轮询**：不需要切窗口检查状态，做完了它会来找你
- **最大化智力密度**：你的每一分钟都在做有价值的事，而不是等待或犹豫
- **批阅奏章体验**：处理完一个，下一个自动出现，流畅不中断

## 2. 核心概念

### 2.1 Task（任务）

一个 Task 是你需要投入注意力的最小单元。它不是"项目"，是一个具体的动作。

**Task 允许"先创建后完善"**——你可以先起一个没名字没优先级的任务绑上 session，后面再补充细节。

```typescript
interface Task {
  id: string
  title?: string                   // 可选，后续补充。如 "Review MixRead 性能优化产出"
  context?: string                 // 让你 5 秒内明白该干嘛的摘要
  priority: 'P0' | 'P1' | 'P2' | 'P3'  // 默认 P2
  type?: 'decision' | 'review' | 'deep_work' | 'quick_action'
  status: 'waiting_agent' | 'queued' | 'active' | 'done' | 'skipped'
  sessions: string[]               // 关联的 session id 列表
  createdAt: number                // 入队时间戳
  queuedAt?: number                // agent 完成、进入等你处理的时间
  startedAt?: number               // 你开始处理的时间
  completedAt?: number             // 你标记完成的时间
  skipCount: number                // 被跳过的次数
  notes?: string                   // 处理完后的备注
}
```

### 2.2 Session（会话）

Session 是独立实体，可以属于某个 Task，也可以自由存在。

```typescript
interface Session {
  id: string
  label?: string                   // 人类可读标签，如 "ccr 主线程"
  agentType: 'claude-code' | 'codex' | 'catdesk' | 'terminal'
  sessionId?: string               // agent 自身的 session id（用于 resume）
  workingDir: string               // 工作目录
  command: string                  // 启动/恢复命令
  status: 'running' | 'waiting' | 'done' | 'closed' | 'suspended'
  taskId?: string                  // 归属的任务 id（null = 自由 session）
  pid?: number                     // 当前进程 PID
  lastOutput?: string              // 最后一屏输出摘要
  createdAt: number
  lastActiveAt: number             // 最后活跃时间
}
```

### 2.3 优先级定义

| 级别 | 含义 | 中断能力 | 举例 |
|------|------|---------|------|
| P0 | 紧急，不处理有严重后果 | 可打断当前任务 | 线上故障、构建阻塞 |
| P1 | 重要，阻塞下游 agent | 排队首位 | agent 等你决策才能继续 |
| P2 | 正常，完成即可 | 正常排队 | review 产出、确认结果 |
| P3 | 低优，有空再做 | 队尾 | 整理文档、非紧急优化 |

### 2.4 任务类型

| 类型 | 含义 | 典型耗时 |
|------|------|---------|
| decision | 需要你做关键判断 | 1-5 min |
| review | 检查 agent 产出 | 3-10 min |
| deep_work | 需要你集中思考 | 15-60 min |
| quick_action | 快速操作即可 | < 1 min |

## 3. 排序算法

### 3.1 默认排序（简单版）

V1 先用简单规则：

```
1. P0 始终置顶
2. 同优先级内，按 queuedAt 排序（先等先处理）
3. 被跳过的任务降权：每次 skip 往后挪一位
```

够用就行。复杂的饥饿惩罚、阻塞加分等后续再加。

### 3.2 Agent 调度（后续）

预留一个 scheduler 接口，后续可以接入本地模型（如 Ollama）或便宜的云模型来做智能排序：

```typescript
interface Scheduler {
  // 给定当前队列和上下文，返回排好序的任务列表
  rank(queue: Task[], context: SchedulerContext): Task[]
}

interface SchedulerContext {
  currentTask?: Task           // 你当前在做什么
  recentCompleted: Task[]      // 最近完成的任务（判断上下文相关性）
  timeOfDay: string            // 时间段（早上适合 deep work？）
  activeSessionCount: number   // 当前活跃 session 数
}
```

agent scheduler 可以做的事：根据你的历史行为判断什么类型的任务你现在最适合做、把相关的任务聚在一起减少切换、在你长时间不处理某任务时主动提升它的优先级。

## 4. 交互设计

### 4.1 主界面：单任务聚焦 + 内嵌终端

界面核心区域永远只展示**一个任务**。这是刻意的设计——减少选择焦虑。

**关键区别：你不需要切到其他窗口。** 任务卡片下方直接内嵌了 agent 的终端，你在同一个页面里看产出、输入指令、标记完成。

```
┌─────────────────────────────────────────────────────────────┐
│  [≡ 队列]                              Dispatch     [⚙️]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│    Review MixRead 性能优化产出                         P1   │
│    ───────────────────────────────────────────────────       │
│    CCR 已完成首页组件重构，产出 3 个文件，需要你 review       │
│    ⏱️  等待: 45min  |  创建于: 14:30                         │
│                                                             │
│    ┌─ Sessions ─────────────────────────────────────────┐   │
│    │ [ccr 主线程 ▾]  [ccr 单测]                         │   │
│    │                                                     │   │
│    │ ┌─────────────────────────────────────────────────┐ │   │
│    │ │ $ claude --resume abc123                        │ │   │
│    │ │                                                 │ │   │
│    │ │ ✓ Refactored src/components/Feed.tsx            │ │   │
│    │ │ ✓ Created src/hooks/useInfiniteScroll.ts        │ │   │
│    │ │ ✓ Created src/utils/prefetch.ts                 │ │   │
│    │ │                                                 │ │   │
│    │ │ I've completed the Feed component refactor.     │ │   │
│    │ │ The infinite scroll logic is now extracted into  │ │   │
│    │ │ a custom hook. Would you like me to proceed     │ │   │
│    │ │ with writing unit tests?                        │ │   │
│    │ │                                                 │ │   │
│    │ │ > _                                            │ │   │
│    │ └─────────────────────────────────────────────────┘ │   │
│    └─────────────────────────────────────────────────────┘   │
│                                                             │
│    ┌────────┐   ┌────────┐   ┌────────────┐                │
│    │✓ 完成  │   │→ 跳过  │   │⏰ 稍后(1h) │                │
│    │ Enter  │   │   S    │   │     L      │                │
│    └────────┘   └────────┘   └────────────┘                │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  队列中还有 4 个任务  |  2 个 agent 工作中  |  今日已完成 8   │
└─────────────────────────────────────────────────────────────┘
```

**工作流**：
1. 系统展示当前任务，内嵌终端自动连接到对应的 agent session
2. 你直接在终端里和 agent 交互（输入指令、看产出）
3. 觉得 OK 了，按 Enter（完成）→ 下一个任务自动出现，终端切换到新任务的 session
4. 或者给 agent 新指令后按 S（跳过）→ agent 继续跑，任务回到队列，你处理下一个

**多 Session Tab**：一个任务关联多个 session 时，终端区域有 tab 切换（如上图的 [ccr 主线程] [ccr 单测]），点击切换显示不同 session 的终端。

### 4.2 键盘快捷键

| 键 | 动作 |
|----|------|
| `Enter` | 完成当前任务，弹出下一个 |
| `S` | 跳过，任务回到队列延后 |
| `L` | 稍后处理（1小时后再出现） |
| `N` | 添加新任务（弹出 input） |
| `Q` | 展开/收起侧边队列面板 |
| `D` | 展开/收起 Dashboard 统计 |
| `1-4` | 打开对应序号的关联 session |

### 4.3 侧边队列面板（按 Q 展开）

```
┌─────────────────────────┐
│ 📋 队列 (5)             │
│                         │
│ → 当前                  │
│   MixRead review   45m  │
│                         │
│   等待中                │
│   🔴 构建失败      2m   │
│   🟡 投资报告      30m  │
│   🟢 AppID整理     2h   │
│   🔵 朋友圈文章    3h   │
│                         │
│ ⏳ Agent 工作中 (2)     │
│   Desktop 打包    15m   │
│   单测生成        8m    │
│                         │
│ ✅ 已完成 (8)           │
│   [展开查看]            │
│                         │
│ ⏰ 稍后 (1)             │
│   技术方案设计   55min后 │
└─────────────────────────┘
```

### 4.4 添加任务

两种方式：

**网页内**：按 `N`，出现一个精简的 input：
```
┌─────────────────────────────────────────┐
│ 新任务: [________________________]      │
│ 优先级: [P1 ▾]  类型: [review ▾]       │
│ 关联 Session: [选择 workspace/pane]     │
│              [添加]  [取消]             │
└─────────────────────────────────────────┘
```

**命令行**（在任何 terminal 中）：
```bash
dispatch add "Review 投资分析报告" --priority P1 --type review \
  --session "workspace:8/pane:120" \
  --context "Claude 已完成三只股票的分析，产出在 ~/output/invest.md"

dispatch add "决定 MixRead 路由方案" --priority P0 --type decision \
  --session "workspace:28/pane:110"

# 快捷方式
dispatch add "检查打包结果" -p2 -t quick
```

### 4.5 P0 中断 Banner

当 P0 任务入队时，如果你正在处理其他任务：

```
┌─────────────────────────────────────────────────────────────┐
│ 🔴 紧急: MixRead 线上构建失败，需要立即决策     [立即处理]   │
└─────────────────────────────────────────────────────────────┘
│                                                             │
│    (你当前正在处理的任务仍然显示在下方)                       │
│    ...                                                      │
```

点"立即处理"会把当前任务暂存，切换到 P0。处理完 P0 后自动回到刚才暂存的任务。

## 5. Session 管理

### 5.1 Session 与 Task 的关系

```
Task 1:N Session      一个任务可以关联多个 session
Session N:1 Task      一个 session 最多属于一个任务
Session 0:1 Task      session 可以无归属（自由 session）
```

**核心设计：Session 是一等公民，不强制绑定任务。**

你可以先快速启动一个 session 干活，后面再给它归属到某个任务、起名字、定优先级。这符合真实的工作流——很多时候你就是"先开个 session 让 agent 跑着"，具体归哪个任务后面再说。

### 5.2 Session 生命周期

```
创建 session（可选绑定任务）
    ↓
running（agent 在跑）
    ↓
waiting（agent 完成，等你输入）
    ↓
你处理后：
  → 继续给指令 → running（循环）
  → 主动关闭 → closed
  → 任务完成 → done
```

### 5.3 Session 操作

| 操作 | 说明 |
|------|------|
| 新启动 | 在任务卡片里点"+ Session"，选 agent 类型和工作目录，spawn 新进程 |
| 关闭 | 点击 session tab 的 × 按钮，kill 进程，标记 closed |
| 解绑 | 把 session 从当前任务移除，变成自由 session |
| 绑定 | 把自由 session 拖到某个任务上，或在 session 上选"归属到任务" |
| 恢复 | session 进程不在了（重启后），系统用 command 重新 spawn |

### 5.4 自由 Session（无任务归属）

自由 session 出现在侧边栏的独立区域"Sessions"里。你可以：
- 快速启动：按快捷键 `Ctrl+N`，选 agent + 目录，立刻开始干活
- 后续归属：干着干着觉得这是个正经任务了，随时创建任务并绑定
- 也可以一直不归属：有些 session 就是临时用用，不需要纳入调度

```
┌─────────────────────────┐
│ 📋 队列 (5)             │
│ ...                     │
│                         │
│ 💻 自由 Sessions (2)    │
│   claude @ MixRead  3m  │
│   codex @ vibeflow  1h  │
│   [+ 新建 Session]      │
└─────────────────────────┘
```

### 5.5 在任务内管理多个 Session

一个任务可以有多个 session（比如一个写代码、一个跑测试、一个看日志）：

- **新启动**：在当前任务的 session tab 栏点 `+`，新 session 自动绑定到当前任务
- **主动关闭**：某个 session 的使命完成了，直接关掉，不影响任务本身
- **任务完成时**：所有关联 session 标记为 done，可选自动关闭或保留

### 5.6 Session 连接与内嵌终端

当你切换到某个任务（或点击某个自由 session）时，系统自动：
1. 检查 session 进程是否还活着（通过 PID）
2. 如果活着 → 直接把已有 pty 的输出流接到 xterm.js
3. 如果不在了（重启/崩溃）→ 用 `command` 字段重新 spawn：
   - Claude Code: `claude --resume <sessionId>`（恢复完整对话上下文）
   - Codex: `codex resume` 选择对应 session
   - 通用终端: 直接 `cd <workingDir> && <command>`

所有交互都在网页内嵌的终端里完成。

### 5.7 Session 回收

- 任务标记 done 后，关联 session 自动标记为"可回收"
- 自由 session 超过 24h 未活跃，提示你是否关闭
- `dispatch sessions clean` 批量清理可回收 session

## 6. 时间统计

### 6.1 每个任务记录

| 指标 | 计算方式 |
|------|---------|
| Agent 工作时间 | queuedAt - createdAt |
| 等待时间（饥饿） | startedAt - queuedAt |
| 你的处理时间 | completedAt - startedAt |
| 端到端 | completedAt - createdAt |

### 6.2 Dashboard 视图（按 D 展开）

```
┌─────────────────────────────────────────────────┐
│ 📊 今日统计                                     │
│                                                 │
│ 你的有效时间      3.2h  ██████████░░░░  62%     │
│ Agent 工作总时长  8.5h                          │
│ 任务完成数        12                            │
│ 平均处理时间      4.2min                        │
│ 平均等待时间      28min                         │
│ 最长饥饿          2.1h (AppID 整理)             │
│                                                 │
│ 吞吐率: 你的 1h → 产出 2.6h 等价工作量          │
│                                                 │
│ ────── 本周趋势 ──────                          │
│ Mon: ████████ 14 tasks                          │
│ Tue: ██████   10 tasks                          │
│ Wed: █████████ 16 tasks  ← 今天                 │
└─────────────────────────────────────────────────┘
```

## 7. 技术架构

### 7.1 核心设计决策：统一界面，内嵌 Agent 交互

**你的所有操作都在同一个网页里完成，不需要切到 cmux。**

方案基于 CloudCLI (claude code ui) 的架构思路——用 node-pty 在服务端 spawn agent 进程，通过 WebSocket 把终端 I/O 流到浏览器里的 xterm.js。但我们不是做一个通用 Web IDE，而是把它嵌入调度系统：任务卡片下方直接展示关联 session 的终端，你在同一个页面里看产出、输入指令、标记完成。

### 7.2 关键能力：Session 持久化与恢复

即使机器重启，任务也不会丢失。每个任务记录完整的 agent 类型和 session 信息：

```typescript
interface SessionRecord {
  id: string                          // 唯一标识
  agentType: 'claude-code' | 'codex' | 'catdesk'
  sessionId: string                   // agent 自身的 session id
  workingDir: string                  // 工作目录
  command: string                     // 启动命令，如 "claude --resume abc123"
  status: 'running' | 'waiting' | 'done' | 'suspended'
  pid?: number                        // 当前进程 PID（运行中时）
  lastOutput?: string                 // 最后一屏输出（用于快速预览）
}
```

**恢复机制**：

| Agent | 恢复方式 | 原理 |
|-------|---------|------|
| Claude Code | `claude --resume <session-id>` | 官方支持，session 存在 ~/.claude/projects/ 下的 JSONL 文件中，重启后可直接恢复完整对话上下文 |
| Codex | `codex resume` 或 `codex resume --last` | 官方支持，conversation 存在本地，可按 session 恢复 |
| CatDesk | 通过 session/conversation ID 恢复 | CatDesk 自身管理 session 持久化 |

tasks.json 里记录了每个 session 的 agentType + sessionId + workingDir + command，机器重启后：
1. 读取 tasks.json，恢复任务队列状态
2. 标记所有 running session 为 suspended
3. 当你处理到某个任务时，系统用记录的 command 重新 spawn agent 并 resume session
4. agent 恢复完整的对话上下文，你继续工作

### 7.3 组件架构

```
┌─────────────────────────────────────────────────────────┐
│                  Web UI (浏览器)                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  任务调度层：单任务聚焦 + 队列面板 + Dashboard    │    │
│  └───────────────────────┬─────────────────────────┘    │
│  ┌───────────────────────▼─────────────────────────┐    │
│  │  Agent 交互层：xterm.js 终端（内嵌在任务卡片中）  │    │
│  └─────────────────────────────────────────────────┘    │
│  React + Vite（参考 CloudCLI 架构）                      │
└────────────────────┬────────────────────────────────────┘
                     │ WebSocket (双向)
                     │  ↑ terminal output stream
                     │  ↓ user input / commands
┌────────────────────▼────────────────────────────────────┐
│              Server (Node.js + Express)                   │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Session Manager  - spawn/resume/kill agent 进程    │ │
│  │                   - node-pty 管理伪终端             │ │
│  │  Task Queue       - 任务 CRUD + 排序引擎           │ │
│  │  State Watcher    - 检测 agent 是否在等待输入       │ │
│  │  Stats Engine     - 时间统计与分析                  │ │
│  │  Persistence      - tasks.json + history.json      │ │
│  └────────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────────┘
                     │ node-pty (伪终端)
┌────────────────────▼────────────────────────────────────┐
│           Agent 进程 (每个 session 一个 pty)              │
│  claude --resume <id> / codex resume / catdesk ...       │
└─────────────────────────────────────────────────────────┘
```

### 7.4 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 前端 | React + Vite | CloudCLI 验证过的方案，xterm.js 集成成熟 |
| 终端模拟 | xterm.js | 浏览器内完整终端，支持颜色/光标/滚动 |
| 后端 | Node.js + Express | 和 node-pty 配合，WebSocket 原生支持 |
| 伪终端 | node-pty | spawn agent 进程，双向 I/O |
| 实时通信 | WebSocket (ws) | terminal stream + 任务状态推送 |
| 数据 | JSON 文件 | 透明、可 git、可手动编辑、重启不丢 |
| CLI | 独立 bin 脚本 | `dispatch add/list/status` |

### 7.5 端口

默认 `localhost:3890`（dispatch 谐音）

### 7.6 数据存储

```
~/code/creo/dispatch/
├── DESIGN.md              # 本文档
├── package.json
├── src/
│   ├── server/
│   │   ├── index.js       # Express + WebSocket server
│   │   ├── session-mgr.js # Agent session 生命周期管理
│   │   ├── pty-pool.js    # node-pty 进程池
│   │   ├── scheduler.js   # 排序引擎
│   │   ├── watcher.js     # Agent 状态检测
│   │   └── stats.js       # 统计模块
│   └── client/
│       ├── App.jsx        # 主应用
│       ├── TaskCard.jsx   # 任务卡片（含内嵌终端）
│       ├── Terminal.jsx   # xterm.js 封装
│       ├── Queue.jsx      # 侧边队列面板
│       └── Dashboard.jsx  # 统计面板
├── bin/
│   └── dispatch.js        # CLI 入口
└── data/
    ├── tasks.json         # 任务队列
    ├── sessions.json      # 所有 session（含自由 session）
    └── history.json       # 已完成任务归档（用于统计）
```

### 7.7 数据文件结构

**data/tasks.json**：
```json
{
  "tasks": [
    {
      "id": "t_1717001234",
      "title": "Review MixRead 性能优化产出",
      "context": "CCR 重构了 Feed 组件，需要确认方向",
      "priority": "P1",
      "type": "review",
      "status": "queued",
      "sessions": ["s_001", "s_002"],
      "createdAt": 1717001234000,
      "queuedAt": 1717004834000,
      "startedAt": null,
      "completedAt": null,
      "skipCount": 0,
      "notes": null
    },
    {
      "id": "t_1717002000",
      "title": null,
      "priority": "P2",
      "status": "waiting_agent",
      "sessions": ["s_003"],
      "createdAt": 1717002000000,
      "skipCount": 0
    }
  ],
  "activeTaskId": null,
  "version": 1
}
```

**data/sessions.json**：
```json
{
  "sessions": [
    {
      "id": "s_001",
      "label": "ccr 主线程",
      "agentType": "claude-code",
      "sessionId": "abc123-def456",
      "workingDir": "/Users/yinshucheng/code/creo/MixRead",
      "command": "claude --resume abc123-def456",
      "status": "waiting",
      "taskId": "t_1717001234",
      "pid": null,
      "lastOutput": "✓ Refactored Feed.tsx...",
      "createdAt": 1717001234000,
      "lastActiveAt": 1717004834000
    },
    {
      "id": "s_004",
      "label": null,
      "agentType": "claude-code",
      "sessionId": "xyz789",
      "workingDir": "/Users/yinshucheng/code/creo/vibeflow",
      "command": "claude --resume xyz789",
      "status": "running",
      "taskId": null,
      "pid": 12345,
      "createdAt": 1717005000000,
      "lastActiveAt": 1717005500000
    }
  ],
  "version": 1
}
```

注意第二个 task 没有 title（后续补充），第二个 session 没有 taskId（自由 session）。

## 8. API 设计

### 8.1 HTTP API

```
# Tasks
GET    /api/current            获取当前应该处理的任务（含关联 session 信息）
GET    /api/queue              获取完整队列
GET    /api/stats              获取统计数据
POST   /api/tasks              创建新任务（title 可选，后续补充）
PATCH  /api/tasks/:id          更新任务（改 title、优先级、context 等）
POST   /api/tasks/:id/done     标记完成
POST   /api/tasks/:id/skip     跳过
POST   /api/tasks/:id/defer    延后（body: { minutes: 60 }）

# Sessions
GET    /api/sessions           获取所有 session（含自由 session）
POST   /api/sessions           创建新 session（快速启动）
PATCH  /api/sessions/:id       更新 session（改 label、绑定/解绑 task）
DELETE /api/sessions/:id       关闭 session（kill 进程 + 标记 closed）
POST   /api/sessions/:id/bind  绑定到任务（body: { taskId }）
POST   /api/sessions/:id/unbind 解绑，变为自由 session

# Session 终端 I/O（通过 WebSocket，见下方）

# History
GET    /api/history            查看历史（支持日期过滤）
```

### 8.2 WebSocket Events

```
Server → Client:
  { type: "queue_updated", queue: [...] }           队列变化
  { type: "new_current", task: {...} }              新的当前任务
  { type: "p0_interrupt", task: {...} }             P0 中断
  { type: "session_output", sessionId, data }       终端输出流
  { type: "session_status", sessionId, status }     session 状态变化
  { type: "stats_updated", stats: {...} }           统计更新

Client → Server:
  { type: "done", taskId, notes? }
  { type: "skip", taskId }
  { type: "defer", taskId, minutes }
  { type: "terminal_input", sessionId, data }       终端输入
  { type: "session_connect", sessionId }            连接到某个 session 的终端流
  { type: "session_disconnect", sessionId }         断开终端流
```

## 9. CLI 设计

```bash
# ═══════════════════════════════════════════════
# 快速启动 session（不需要先有任务）
# ═══════════════════════════════════════════════

# 启动一个自由 session，后面再归属任务
dispatch run --agent claude-code --cwd ~/code/creo/MixRead
dispatch run --agent codex --cwd ~/code/creo/vibeflow
dispatch run --agent terminal --cwd ~/code/creo/MixRead --cmd "npm test"

# 启动并立即绑到新任务
dispatch run --agent claude-code --cwd ~/code/creo/MixRead \
  --task "优化首页性能" -p1

# ═══════════════════════════════════════════════
# 任务管理
# ═══════════════════════════════════════════════

# 创建任务（可以不填 title，后续在网页上补）
dispatch add [title] [options]
  -p, --priority <P0|P1|P2|P3>    优先级，默认 P2
  -t, --type <type>                类型
  -c, --context <text>             上下文描述

# 自动检测当前目录的 claude session 并创建任务
dispatch add "Review 优化产出" --auto-detect

# 查看
dispatch status                    当前任务 + 队列摘要
dispatch list                      列出所有任务
dispatch stats                     今日统计

# 操作
dispatch done [id]                 完成当前/指定任务
dispatch skip [id]                 跳过
dispatch defer [id] [minutes]      延后

# ═══════════════════════════════════════════════
# Session 管理
# ═══════════════════════════════════════════════

dispatch sessions                  列出所有 session（含自由 session）
dispatch sessions --free           只看自由 session
dispatch sessions --stale          只看可回收的
dispatch sessions kill <id>        关闭指定 session
dispatch sessions clean            批量清理可回收 session
dispatch sessions bind <sid> <tid> 把 session 绑到任务

# ═══════════════════════════════════════════════
# 服务
# ═══════════════════════════════════════════════

dispatch serve                     启动 server（含 Web UI）
dispatch serve --port 3890         指定端口
dispatch serve --open              启动后自动打开浏览器
```

## 10. 实现分期

### Phase 1: 最小可用（先做这个）

- [x] tasks.json 数据结构（含 session 持久化字段）
- [ ] Node server：Express + WebSocket + node-pty
- [ ] 前端：React + Vite + xterm.js
- [ ] 核心体验：单任务聚焦 + 内嵌终端 + 完成/跳过/稍后
- [ ] Session spawn/resume：支持 claude --resume
- [ ] CLI：`dispatch add` + `dispatch serve`
- [ ] 键盘快捷键（Enter/S/L）

### Phase 2: 完善体验

- [ ] 多 session tab 切换
- [ ] 排序算法（带饥饿惩罚 + 阻塞加分）
- [ ] P0 中断 banner
- [ ] 侧边队列面板
- [ ] 时间统计 + Dashboard
- [ ] Session 状态持久化（重启恢复）
- [ ] `dispatch add --auto-detect`（自动检测 claude session id）

### Phase 3: 智能化

- [ ] Agent 状态自动检测（通过分析终端输出判断是否在等待输入）
- [ ] Codex session 恢复支持
- [ ] CatDesk automation 集成
- [ ] Session 健康度监控（CPU/内存、空闲时长）
- [ ] 自动建议任务优先级调整
- [ ] 历史趋势分析 + 效率报告

## 11. 使用场景举例

### 场景 A：开始一天的工作

1. 打开 localhost:3890（你的 Dispatch 界面）
2. 在终端里给各个项目布置任务：
   ```bash
   dispatch add "MixRead 首页性能优化" -p1 -t review \
     --agent claude-code --session-id abc123 \
     --cwd ~/code/creo/MixRead --cmd "claude --resume abc123"
   ```
3. 或者直接在网页里按 N 添加新任务，选择 agent 类型
4. Agent 们在后台跑（server 通过 node-pty 管理进程）
5. 你在同一个网页上处理队列：看产出→输入指令→完成→下一个

### 场景 B：处理一个 review 任务

1. 系统展示"MixRead 性能优化 review"，内嵌终端自动连接到 claude session
2. 你看到 agent 说"重构完成，需要你确认"
3. 你在终端里输入 "looks good, proceed with unit tests"
4. Agent 开始跑单测 → 你按 S（跳过），任务回到队列
5. 下一个任务自动出现，终端无缝切换到另一个 agent session
6. 等单测跑完，那个任务会重新排到队列前面来找你

### 场景 C：机器重启后恢复

1. 重启后 `dispatch serve` 启动 server
2. 打开网页，看到所有任务还在，session 标记为 "suspended"
3. 切到第一个任务，系统自动执行 `claude --resume <session-id>`
4. Claude Code 恢复完整对话上下文，你继续上次的工作
5. 就像什么都没发生过一样

### 场景 D：深度工作中被 P0 打断

1. 你正在网页上和某个 agent 交互
2. 页面顶部出现红色 banner："紧急：线上构建失败需要决策"
3. 你点"立即处理"，当前任务暂存，终端切换到 P0 对应的 session
4. 处理完 P0，按 Enter 完成
5. 系统自动恢复你之前暂存的任务，终端切回原来的 session

### 场景 E：晚上收工前

1. 按 D 展开 Dashboard
2. 看到今天完成了 15 个任务，agent 帮你干了 12h 的活
3. 3 个 session 标记为"可回收"（任务已完成的 session）
4. 跑 `dispatch sessions clean` 清理
5. 关掉浏览器，session 状态自动持久化在 tasks.json 里

## 12. 设计原则

1. **单任务聚焦**：界面永远只突出一个任务，减少决策疲劳
2. **统一界面**：所有操作（看产出、输入指令、切 session、标记完成）都在同一个网页完成
3. **Session 不死**：机器重启、进程崩溃都不怕，任务和 session 信息持久化在 JSON 里，随时可恢复
4. **零配置启动**：`dispatch serve` 一个命令就跑起来
5. **数据透明**：JSON 文件，随时可以手动查看/编辑，也可以被其他工具消费
6. **渐进增强**：Phase 1 就能用，后续功能不影响核心体验
7. **键盘优先**：核心操作都有快捷键，不依赖鼠标
8. **不做项目管理**：这不是 Jira/Linear，这是你的个人调度器

## 13. 开源参考

| 项目 | 借鉴点 |
|------|--------|
| [CloudCLI (Claude Code UI)](https://github.com/siteboon/claudecodeui) | node-pty + xterm.js + WebSocket 架构、session 发现机制、React + Vite 前端 |
| [Claude Code 官方 Session 管理](https://code.claude.com/docs/en/sessions) | `--resume <session-id>` 恢复对话、session 存储在 ~/.claude/projects/ |
| [Codex CLI](https://github.com/openai/codex) | `codex resume` 恢复会话、本地 conversation 持久化 |
| [claude-web-ui](https://github.com/heng1234/claude-web) | pip install 一键启动的设计理念、多会话管理 |
