# Dispatch × Commander 整合设计

> 把 Commander 文档里想清楚的「事件采集」接到 Dispatch 已跑通的「队列 + 单任务面板」上。
> 同一个理念（皇帝批阅奏章）的两半合体：Commander 解决"谁完成了"，Dispatch 解决"怎么处理"。

## 0. 已定方向（来自讨论）

| 决策 | 结论 |
|------|------|
| 项目名 | **Commander**（CLI 为 `commander`，别名 `cmd`） |
| 底座 | **Dispatch 已跑通的代码为底**，吸收 Commander 思想，不重写 |
| 实体模型 | **Session 一等公民 + Task 可选聚合**。session 进来自动生成 1:1 隐式 task；一件事需多 session 时 task 才显式存在 |
| 界面 | **浏览器为主**（继续 Dispatch 的 React+Vite），最终全在浏览器；未来可轻客户端壳包浏览器 |
| 事件采集 | **Hook 为主 + 扫描兜底**。装全局 Claude Code hook 精确推事件；扫描负责启动时列出历史会话 |
| waiting 信号 | **Hook 精确触发**（~95%+）：Notification→waiting、Stop→completed、SessionStart→started。扫描启发式仅作历史会话的近似补充 |
| 静默阈值 N | **3 分钟**（仅用于扫描兜底/无 hook 数据的会话；可配置，默认 180s） |
| Hook 安装 | **全局**（`~/.claude/settings.json`），一次装好所有项目生效；`commander install-hooks` 命令一键写入 |
| 代码目录 | 合并进 `commander/`（与已有 docs/POC 合一，纳入 git） |
| 交付方式 | **一次性完整实现**（设计抠清后再动手） |

## 1. 验证发现（决定方案形态的关键事实）

在本机实测 `~/.claude/projects` 与进程扫描：

**能拿到（足够渲染面板）：**
- `<project>/sessions-index.json` → `entries[]`：sessionId、summary、firstPrompt、projectPath、gitBranch、messageCount、created/modified、fileMtime
- `ps` 扫描：当前真有 ~10 个 claude 进程，PID/CPU/etime 可得

**拿不到 / 不可靠：**
- **进程 ↔ 会话对不上**：claude 进程命令行是 `claude --dangerously-skip-permissions --settings .../ccr-settings-xxx.json`（走 claude-code-router），**不含 session id / cwd**。无法可靠把 PID 映射到具体会话。
- **JSONL 末行判断"在等输入"不可靠**：采样末行多为 `system` 或非标准结构，`stop_reason` 信号脏。

**结论**：只读方案能做到「展示有哪些会话、按 mtime 排序、哪些近期活跃」，但**做不到精确区分 running / waiting**。而 waiting 正是"自动冒出来找你"最想要的状态。方案需正视这个落差。

## 2. 整合后的核心模型

```
Session（一等公民）                Task（可选聚合层）
  来源：                            - 默认：每个被纳入的 session 自动生成 1:1 隐式 task
   a) claude 数据扫描（自动发现）    - 显式：你把多个 session 归到一个 task（写码+测试+日志）
   b) dispatch add/run（手动）       - 隐式 task 对用户透明，面板上看到的是"会话/任务"二合一
  状态：discovered | active | idle | done | dismissed
```

- Dispatch 现有 Task/Session 结构**保留**，只加：
  - Session 增 `source: 'scan' | 'manual'`、`origin`（扫描来源路径/sessionId）
  - Task 增 `implicit: boolean`（扫描自动建的隐式任务）
- 扫描发现的 session → 自动建隐式 task 进队列；你 dismiss 掉就不再冒出来。

## 3. 状态语义（扫描启发式，诚实版）

每个会话的状态由「末条非噪音事件类型」+「文件静默时长」共同决定：

| 面板状态 | 判定 | 含义 |
|----------|------|------|
| 🔵 在跑 | 文件 mtime 距今 < N(180s) | 会话正在被写，agent 活跃中 |
| 🟡 可能在等你 | 静默 ≥ N **且** 末条非噪音事件是 `assistant` | agent 说完话停下了，大概率在等你 |
| ⚪ 静默 | 静默 ≥ N **且** 末条是 `user`/`tool_use` 等 | 停了，但不是典型的等待态（可能卡了/你没接） |
| ✓ 已处理 | 你在面板上 dismiss / done | 不再冒出 |

**准确度自知**：🟡 约 70-75% 准，系统性偏漏报（真在等的可能被判成 🔵 或 ⚪，但不会乱报）。
要 95%+ 需装 hook —— 列入 Phase C，现在不做。

### 3.1 末状态判定算法（可照抄）

```
NOISE_TYPES = { 'file-history-snapshot', 'attachment', 'system',
                'mode', 'permission-mode', 'last-prompt', 'queue-operation' }

function classify(jsonlPath, now):
    mtime = stat(jsonlPath).mtime
    idleSec = (now - mtime) / 1000
    if idleSec < N:           return { state: 'running', idleSec }   # 🔵
    # 静默了，回溯找末条「非噪音」事件判断停在谁那
    lastMeaningful = readLastLines(jsonlPath, upTo=40)
                       .reverse()
                       .find(ev => ev.type not in NOISE_TYPES)
    role = lastMeaningful?.message?.role || lastMeaningful?.type
    if role == 'assistant':   return { state: 'waiting', idleSec }   # 🟡 可能在等你
    else:                     return { state: 'idle',    idleSec }   # ⚪ 静默
```

> 实现要点：只 `tail` 读末尾若干行（不整文件读，会话 JSONL 可能很大），从后往前找第一条非噪音事件。

## 4. 落地分期

### Phase A：会话发现层（核心整合，最小）
- [ ] `scanner.js`：读所有 `sessions-index.json`，聚合成 session 列表（按 mtime 排序）
- [ ] 扫描结果 → 自动建/更新隐式 task 进 Dispatch 队列（去重：按 sessionId）
- [ ] 面板单任务卡复用现有 UI，展示 summary / projectPath / gitBranch / 活跃时长
- [ ] dismiss 后不再冒出（持久化 dismissed sessionId 集合）
- [ ] 定时扫描 + 文件 watch（chokidar 或 fs.watch）→ ws 推送，会话自动冒出来

### Phase B：跳转 + 体验打磨
- [ ] "打开 session"：显示 `claude --resume <sid>` + cwd + 复制（已有）
- [ ] 可插拔跳转后端（Commander 借鉴）：复制命令 / 激活 cmux / iTerm，留接口
- [ ] 进程扫描叠加："有 N 个 claude 在跑"作为粗粒度佐证（不绑定到具体会话）
- [ ] 排序：活跃优先 + 静默时长降权

### Phase C（可选，验证后再做）
- [ ] 装 Claude Code hook（Stop/Notification/SessionStart）→ 精确 waiting 状态
- [ ] 多 agent（Codex/CatDesk）发现
- [ ] 时间统计 Dashboard

## 5. 不做（明确边界）
- 不做 Commander 文档里的团队版 / GitLab / IM / CI 插件（那是远期愿景，不是现在）
- 不重写成 TUI（浏览器底座已验证）
- Phase A/B 不装 hook（零侵入优先，验证核心后再说）

## 6. 开放问题
- 隐式 task 的"完成"语义：dismiss 了它还会因为 mtime 更新再冒出来吗？→ 倾向：dismiss 记住 + 只有"新消息且你没看过"才重新冒出
- 静默阈值 N 取多少分钟？→ 先拍 5min，可配置
