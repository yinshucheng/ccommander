# Dispatch V1 实现计划（纯调度面板）

> 目标：验证「批阅奏章」核心体验。砍掉内嵌终端，最小风险跑通主循环。

## 1. V1 范围

**做：**
- 任务队列 + 单任务聚焦面板（永远只显示 1 个任务）
- 完成 / 跳过 / 稍后 三个操作 + 键盘快捷键
- 「打开 session」= 显示命令 + 工作目录 + 上次输出摘要（你自己切过去处理）
- 侧边队列面板（按 Q）
- WebSocket 实时推送：处理完一个 → 下一个自动弹出
- CLI：`dispatch add` / `serve` / `list` / `done`
- JSON 持久化（tasks / sessions / history），重启不丢

**不做（推迟）：**
- node-pty / xterm.js 内嵌终端
- 自动检测 agent 完成状态（手动标记）
- 智能排序（先用 DESIGN 3.1 简单规则）
- Dashboard 统计图表（V1 留占位，数据先记着）
- P0 中断 banner（V1 简化为：P0 直接排队首位）

## 2. 数据模型

直接采用 DESIGN.md 的 `Task` / `Session` 结构，V1 简化：
- Task：`id, title?, context?, priority, type?, status, sessions[], createdAt, queuedAt?, startedAt?, completedAt?, skipCount, deferUntil?, notes?`
- Session：`id, label?, agentType, sessionId?, workingDir, command, status, taskId?, lastOutput?, createdAt, lastActiveAt`（V1 无 pid，因为不 spawn 进程）

状态机简化：
- Task status: `queued | active | done | skipped`（V1 暂不用 waiting_agent，因为没有自动检测）
- defer：用 `deferUntil` 时间戳，到点了重新进 queue

## 3. 排序算法（DESIGN 3.1）

```
1. deferUntil 未到的任务不参与排序（隐藏）
2. P0 > P1 > P2 > P3
3. 同优先级按 queuedAt 升序（先等先处理）
4. skipCount 降权：每次 skip 在同优先级内往后挪
当前任务 = 排序后第一个 status=queued 的任务
```

## 4. 文件结构

```
dispatch/
├── DESIGN.md
├── PLAN_V1.md            # 本文件
├── package.json          # type: module, scripts
├── vite.config.js        # 前端 dev server + proxy /api、/ws 到后端
├── bin/
│   └── dispatch.js       # CLI 入口（add/serve/list/done）
├── src/
│   ├── server/
│   │   ├── index.js      # Express + ws，挂 API + 静态资源
│   │   ├── store.js      # JSON 读写 + 内存状态 + 原子写
│   │   ├── scheduler.js  # 排序 + 选 current
│   │   ├── tasks.js      # 任务 CRUD / done / skip / defer
│   │   └── bus.js        # 事件广播（WebSocket 推送）
│   └── client/
│       ├── main.jsx
│       ├── App.jsx       # 主应用 + ws 连接 + 快捷键
│       ├── TaskCard.jsx  # 单任务卡（含 session 命令展示）
│       ├── Queue.jsx     # 侧边队列面板
│       └── api.js        # fetch 封装
└── data/
    ├── tasks.json
    ├── sessions.json
    └── history.json
```

## 5. HTTP API（DESIGN 8.1 子集）

```
GET    /api/current              当前任务 + 关联 session
GET    /api/queue                完整队列（分组：current/waiting/deferred/done）
POST   /api/tasks                创建任务
PATCH  /api/tasks/:id            更新
POST   /api/tasks/:id/done       完成（body: notes?）
POST   /api/tasks/:id/skip       跳过
POST   /api/tasks/:id/defer      延后（body: minutes）
GET    /api/sessions             所有 session
POST   /api/sessions             创建 session 记录
PATCH  /api/sessions/:id         更新 / 绑定 task
```

## 6. WebSocket（DESIGN 8.2 子集）

```
Server → Client:
  { type: "queue_updated", queue }
  { type: "new_current", task }
Client → Server: 操作走 HTTP，ws 只用于接收推送（V1 简化）
```

## 7. CLI

```bash
dispatch serve [--port 3890] [--open]
dispatch add [title] [-p P1] [-t review] [-c "context"] \
             [--session-id abc] [--cwd ~/x] [--cmd "claude --resume abc"]
dispatch list
dispatch done [id]
```
CLI 通过 HTTP 调本地 server（server 没起则提示先 `dispatch serve`）。

## 8. 任务拆解（建议顺序）

1. `package.json` + 依赖（express, ws, vite, react）+ 数据目录骨架
2. `store.js`：JSON 读写 + 原子写 + 默认数据
3. `scheduler.js`：排序 + 选 current（带单测可选）
4. `tasks.js` + `index.js`：HTTP API + ws 广播
5. `bin/dispatch.js`：CLI（add/serve/list/done）
6. 前端：App + TaskCard + Queue + 快捷键 + ws
7. 串起来跑通：add 任务 → 面板显示 → 完成 → 下一个弹出
8. 自测脚本：造几条任务验证排序与主循环

## 9. 验收标准

- `dispatch serve` 一条命令起服务 + 前端
- 终端 `dispatch add` 加任务，浏览器面板**自动**出现该任务（ws 推送）
- 面板只显示 1 个任务，展示 title/context/priority/等待时长 + session 命令与目录
- 按 Enter 完成 → 下一个任务自动弹出；S 跳过；L 稍后 1h
- 按 Q 展开侧边队列，看到 waiting/deferred/done 分组
- 重启 server，任务队列仍在（JSON 持久化）

## 10. 技术决策

| 点 | 选择 | 理由 |
|----|------|------|
| 包管理 | pnpm | 已装，快 |
| 模块 | ESM (type: module) | node 24 原生支持 |
| 前端构建 | Vite + React | DESIGN 选型，生态成熟 |
| 数据 | JSON 文件 + 原子写（写 tmp 再 rename） | 透明、可手编、重启不丢 |
| 端口 | 3890 | DESIGN 既定 |
| 生产形态 | server 同时托管 vite build 产物；dev 时 vite proxy | 单命令启动 |
