# Commander MVP — 产品需求文档

## 一句话定义

终端实时指挥台，汇总所有 AI 实例状态，支持逐条批阅、会话管理和一键跳转。

---

## 核心用户场景

### 场景 1：多实例并行，不知道该看哪个

> 我开了 5 个 Claude Code，分别在不同项目上干活。打开 Commander，一眼看到：
> ```
>  ⏳ lessnote       hook优化              等待 3m
>  ✅ vibeflow       修复iOS权限问题        完成 2m前
>  ✅ data-agent     SQL查询优化            完成 刚刚
>  🔄 flash-app     前端样式调整            运行 8m
>  🔄 magic-bar     数字人对话逻辑          运行 1m
> ```
> 按回车跳到 lessnote 处理，处理完自动高亮下一条。

### 场景 2：会话管理焦虑 — 不敢关，怕找不回来

> 一个项目同时跑了 6 个 Claude Code 会话。有的需要持续跟进，有的已经完成可以关了，有的想总结一下再关。
> 但我不敢随便关，因为关了之后在 `/resume` 列表里翻半天也找不到。
>
> Commander 里能看到同一项目的所有会话，每个都有清晰的描述。
> 我可以标记："⭐ 持续关注" / "📝 待总结" / "✓ 可关闭"。
> 不用记住 session ID，不用在标签页之间翻。

### 场景 3：长时间运行，不确定是卡了还是在跑

> flash-playground 已经跑了 15 分钟没动静。Commander 显示 `🔄 运行 15m`，一看就知道可能卡了。

### 场景 4：一天结束，回顾 AI 帮我干了什么

> Commander 底部状态栏：`今日: 12 完成 | 4 个项目 | 6h 总运行`

---

## MVP 功能清单

### P0：必须有

#### 1. 事件采集（改造现有 hook）
- [ ] Claude Code Stop hook → 写 `completed` 事件到 `~/.commander/events.jsonl`
- [ ] Claude Code Notification hook → 写 `waiting` 事件
- [ ] Claude Code SessionStart hook → 写 `started` 事件
- [ ] 每条事件：timestamp、session_id、project_root、project_name、session_name、event_type

#### 2. TUI 实时面板
- [ ] 实时显示所有活跃会话的状态
- [ ] 每行：状态图标 + 项目名 + 会话描述 + 持续/等待时间
- [ ] 按状态排序：⏳等待 > ✅完成(未处理) > 🔄运行中
- [ ] 自动刷新（tail -f events.jsonl）
- [ ] 同一项目多会话时，项目名分组显示

#### 3. 批阅操作
- [ ] `Enter`：跳转模式 — 激活对应项目 CatPaw 窗口 + 复制 `claude --resume <sid>` 到剪贴板，用户 Cmd+V 即可恢复会话
- [ ] `o`：进入模式 — 暂停 Commander，在当前终端直接 `claude --resume <sid>` 进入会话，退出后回到 Commander
- [ ] `d`：标记已处理（从活跃列表移除）
- [ ] `j/k`：上下移动
- [ ] `q`：退出

#### 4. 会话追踪
- [ ] 展示同一项目下的所有活跃会话
- [ ] 显示每个会话的描述（summary / 首条消息）
- [ ] `s`：标记 ⭐ 持续关注（置顶）
- [ ] `n`：标记 📝 待总结
- [ ] 已标记的会话不会被自动清理

### P1：MVP 后第一批

- [ ] 底部状态栏：今日统计
- [ ] 声音提醒：新的 waiting 事件到来时播放红警音效
- [ ] `?`：显示帮助面板
- [ ] 会话描述支持手动备注（附加一句话说明这个会话在干嘛）

### P2：锦上添花

- [ ] Vibeflow 集成：会话关联到目标/项目
- [ ] 支持 Cursor 等其他 AI 工具
- [ ] 菜单栏 app 版本

---

## 技术方案

### 事件格式（JSONL）

```jsonl
{"ts":"2026-03-09T14:30:00Z","type":"started","sid":"abc123","root":"/Users/x/code/creo/vibeflow","project":"vibeflow","name":"修复iOS权限"}
{"ts":"2026-03-09T14:35:00Z","type":"completed","sid":"abc123","root":"/Users/x/code/creo/vibeflow","project":"vibeflow","name":"修复iOS权限"}
{"ts":"2026-03-09T14:36:00Z","type":"waiting","sid":"def456","root":"/Users/x/code/creo/lessnote","project":"lessnote","name":"hook优化"}
```

### 状态机

```
SessionStart → started → 🔄 运行中（推断）
Stop hook    → completed → ✅ 完成
Notification → waiting → ⏳ 等待

用户操作：
  d → dismissed（从面板移除）
  s → starred（置顶关注）
  n → noted（待总结）
```

### 数据源

Commander 不只读自己的 events.jsonl，还可以直接读 Claude Code 已有的数据：

- `~/.claude/projects/*/sessions-index.json` — 所有会话的 summary、projectPath
- `ps aux | grep claude` — 当前正在运行的 Claude Code 进程
- events.jsonl — hook 实时推送的增量事件

**这意味着即使不改任何 hook，Commander 也能展示"当前有哪些 Claude Code 在跑"。** hook 事件只是让状态更精确（区分 running/waiting/completed）。

### 技术栈

- **语言**：TypeScript（和 Claude Code 生态一致）
- **TUI 框架**：Ink（React for CLI）— 组件化开发，生态好
- **事件总线**：JSONL 文件 + chokidar 监听
- **发布**：npm 包，`npx commander-ai` 直接用

### 目录结构

```
commander/
├── src/
│   ├── index.tsx          # 入口
│   ├── components/
│   │   ├── Dashboard.tsx  # 主面板
│   │   ├── SessionRow.tsx # 单行会话
│   │   └── StatusBar.tsx  # 底部统计
│   ├── data/
│   │   ├── events.ts      # 读写 events.jsonl
│   │   ├── claude.ts      # 读 Claude Code sessions-index
│   │   └── process.ts     # 检测运行中的 claude 进程
│   └── types.ts
├── hook/
│   └── commander-hook.sh  # 供用户 source 的 hook 脚本
├── docs/
│   └── PRD.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## 非目标（MVP 不做）

- 不做跨机器同步
- 不做 Web 版
- 不做多用户
- 不做历史回放/时间线
- 不做自动关闭/重启会话

---

## 成功标准

MVP 成功 = **我每天用它来管理 AI 会话，不再在 CatPaw 标签页之间翻找，也不再害怕关掉某个会话。**

---

## 开源策略

Commander 作为独立项目开源：
- **无依赖即可用**：装 hook + 启动 TUI = 完整体验
- **Vibeflow 是增值插件**：接上后多一层目标绑定，但不是必需
- **npm 包发布**：`npx commander-ai` 一行启动，零配置
