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

### 插件架构（核心设计）

> 老板反馈：外部工具做成插件，可便捷集成。Claude Code 作为第一个，后续接入 OpenClaw、OpenCode 等。

每个插件实现统一接口：

```typescript
interface CommanderPlugin {
  name: string;           // e.g. "claude-code", "openclaw", "gitlab"
  icon: string;           // e.g. "🤖", "🐙", "🔀"

  // 拉取当前所有活跃会话/任务
  getSessions(): Promise<Session[]>;

  // 监听实时事件（可选，不实现则靠轮询 getSessions）
  watch?(callback: (event: SessionEvent) => void): void;

  // 用户操作
  actions: {
    jump(session: Session): void;      // 跳转到对应窗口
    resume?(session: Session): void;   // 恢复/进入会话
    dismiss?(session: Session): void;  // 关闭/归档
  };
}
```

MVP 插件清单：

| 插件 | 数据源 | 状态 |
|------|--------|------|
| `claude-code` | sessions-index.json + hook 事件 + 进程检测 | **MVP 首发** |
| `openclaw` | OpenClaw API / 本地状态 | Phase 2 |
| `opencode` | 类似 Claude Code 的会话文件 | Phase 2 |
| `gitlab` | GitLab API + Webhook | Phase 2 |
| `lark` | 大象 Bot API | Phase 3 |

### 目录结构

```
commander/
├── src/
│   ├── index.tsx              # 入口
│   ├── core/
│   │   ├── plugin.ts          # 插件接口定义
│   │   ├── event-bus.ts       # 统一事件总线
│   │   └── session-store.ts   # 会话状态聚合
│   ├── plugins/
│   │   ├── claude-code/       # Claude Code 插件
│   │   │   ├── index.ts
│   │   │   ├── sessions.ts    # 读 sessions-index.json
│   │   │   ├── process.ts     # 检测运行中进程
│   │   │   └── hook.ts        # 解析 hook 事件
│   │   └── README.md          # 插件开发指南
│   ├── components/
│   │   ├── Dashboard.tsx      # 主面板
│   │   ├── SessionRow.tsx     # 单行会话
│   │   └── StatusBar.tsx      # 底部统计
│   └── types.ts
├── hooks/
│   └── claude-code-hook.sh    # Claude Code hook 脚本
├── docs/
│   ├── PRD.md
│   ├── VISION.md
│   └── TEAM-REQUIREMENTS.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## 竞品分析：cmux（2026-03 新增）

> cmux (cmux.com) — 基于 Ghostty/libghostty 的原生 macOS 终端，专为多 AI agent 并行打造。开源，Mitchell Hashimoto 推荐，HN #2，日本开发者社区病毒传播。

### cmux 核心特性

| 特性 | 说明 |
|------|------|
| 垂直标签页 | 侧边栏显示 git 分支、工作目录、端口、通知文本 |
| 通知提醒环 | Agent 需要关注时标签页亮灯（OSC 9/99/777 + `cmux notify` CLI） |
| 内置浏览器 | 终端旁分屏，可编程 API，查看 PR/dev server |
| 分屏面板 | 水平+垂直分屏 |
| Socket API / CLI | 完整编程接口：创建 workspace/tab、分屏、发送按键、打开 URL |
| GPU 加速 | libghostty 渲染 |
| 原生轻量 | Swift + AppKit，无 Electron |

### Commander vs cmux：定位差异

| 维度 | Commander | cmux |
|------|-----------|------|
| **本质** | 调度大脑（该看哪个、该做什么） | 终端容器（所有窗口在一个地方） |
| **隐喻** | 皇帝批阅奏章 | tmux 升级版 |
| **状态语义** | 丰富状态机（started→waiting→completed→dismissed/starred） | 二值通知（亮/不亮） |
| **目标绑定** | 会话关联 Vibeflow 项目/年度目标 | 无，纯终端 |
| **跨工具** | 插件架构，接 GitLab/IM/CI | 只管终端内 agent |
| **批阅流** | d 已处理、s 收藏、n 待总结，可回溯 | 无，点标签页切换 |
| **内置浏览器** | 无 | 有，可编程 |
| **分屏** | 无（TUI 单面板） | 有 |

**结论：不是竞品，是互补。cmux 解决"终端在哪里"，Commander 解决"该看哪个"。**

### 从 cmux 借鉴的想法

1. **Socket API 作为跳转通道**
   - Commander 当前跳转方案是"激活 CatPaw 窗口 + 复制 resume 命令到剪贴板"，笨拙
   - 如果用户用 cmux 作为终端，Commander 可通过 `cmux` CLI/socket 直接跳转到对应 workspace/surface，体验更丝滑
   - **行动项**：Commander 的 `jump()` action 应该支持多种跳转后端（CatPaw AppleScript / cmux socket / iTerm2 等），做成可插拔

2. **通知标准化：OSC 终端序列**
   - cmux 用 OSC 9/99/777 检测 agent 通知，这是终端标准协议
   - Commander 的 hook 事件采集也可以兼容这个协议，不仅仅靠 JSONL
   - 好处：即使用户不装 Commander hook，只要终端支持 OSC，也能有基本的状态感知

3. **内置浏览器的需求验证**
   - cmux 用户高频使用场景：一边 agent 一边看 PR/dev server
   - Commander Phase 3 可考虑内联浏览器面板，或至少支持 `b` 快捷键打开关联 URL（MR 链接、部署预览）

4. **cmux 作为 Commander 的宿主终端**
   - 最佳组合：cmux 负责终端渲染+分屏+浏览器，Commander 作为 cmux 内的一个 workspace 提供调度视图
   - Commander 通过 cmux socket API 控制其他 workspace（创建、跳转、发送命令）
   - 这样 Commander 不需要自己做终端渲染，专注调度逻辑

### 对 Commander 技术方案的影响

插件的 `jump()` action 应改为：

```typescript
interface JumpTarget {
  type: 'cmux' | 'catpaw' | 'iterm2' | 'terminal';
  // cmux: cmux select-workspace + select-surface
  // catpaw: AppleScript 激活窗口
  // iterm2: AppleScript
  // terminal: 直接在当前终端 resume
}
```

MVP 仍以 CatPaw/通用终端 为默认跳转后端，cmux 作为可选增强。

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
