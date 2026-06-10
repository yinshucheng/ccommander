# Commander 完整实现计划（一次性交付）

> Dispatch 已跑通的「队列+面板」 + Commander 的「事件采集」，合并进 `commander/`。
> 关键发现：本机**已有成熟 hook 基础设施**，`parse-hook.py` 已提取全部所需字段，
> hook 那一环只需在现成脚本末尾各加一行 echo。

## 0. 锁定的决策

| 项 | 结论 |
|----|------|
| 项目名 | **Commander**，CLI `commander`（别名 `cmd`） |
| 底座 | Dispatch 已跑通代码（Express+ws+React+Vite+JSON） |
| 目录 | 代码合并进 `~/code/creo/commander/`（已有 git + docs + poc） |
| 模型 | Session 一等公民 + Task 可选聚合；session 进来自动建 1:1 隐式 task |
| 界面 | 浏览器（React+Vite），单任务聚焦 + 队列 |
| 事件采集 | **Hook 为主 + 扫描兜底** |
| waiting 信号 | Hook 精确：Notification→waiting、Stop→completed、SessionStart/UserPromptSubmit→running |
| 静默阈值 | 扫描兜底用 180s |
| Hook 安装 | 复用现有全局 hook，追加写 `~/.commander/events.jsonl`；`commander install-hooks` 幂等写入 |

## 1. 现有资产盘点（必须复用，别重造）

### dispatch/ 已实现（直接迁移）
- `src/server/`: store.js / scheduler.js / tasks.js / bus.js / index.js
- `src/client/`: App / TaskCard / Queue / AddTask / styles
- `bin/dispatch.js`: CLI
- 已验证：add→面板→done→下一个、排序、ws 推送、持久化

### 本机 hook 基础设施（复用，不动其行为）
- `~/.claude/settings.json`：已配 Notification(idle_prompt)→notify-waiting.sh、Stop→notify-done.sh，及 vibe-island-bridge 全事件
- `~/.claude/scripts/parse-hook.py`：**已提取** session_id、PROJECT_NAME、PROJECT_ROOT、SESSION_NAME(summary优先)、CWD、FIRST_MSG
- `~/.claude/scripts/notify-waiting.sh` / `notify-done.sh`：现成 hook 落点
- `~/.claude/projects/*/sessions-index.json`：summary/projectPath/gitBranch/mtime（扫描兜底用）

## 2. 目标目录结构（commander/）

```
commander/
├── docs/                      # 保留：PRD/VISION/TEAM-REQUIREMENTS
├── poc/                       # 保留：Skill UI POC（与本功能无关，归档）
├── INTEGRATION.md             # 从 dispatch/ 迁入（整合设计）
├── package.json               # name: commander, bin: commander
├── vite.config.js
├── bin/
│   └── commander.js           # CLI: serve/add/list/done/skip/defer + install-hooks
├── hooks/
│   └── commander-emit.sh      # 被 claude hook 调用，追加事件到 events.jsonl
├── src/
│   ├── server/
│   │   ├── index.js           # Express + ws + 静态托管
│   │   ├── store.js           # tasks/sessions/history JSON 原子写
│   │   ├── scheduler.js       # 排序（活跃优先 + 优先级 + 静默降权）
│   │   ├── tasks.js           # Task/Session CRUD + done/skip/defer
│   │   ├── bus.js             # ws 广播
│   │   ├── events.js          # 【新】消费 ~/.commander/events.jsonl（watch+tail）
│   │   ├── scanner.js         # 【新】扫 sessions-index.json + 进程，兜底发现历史会话
│   │   └── ingest.js          # 【新】事件/扫描 → upsert session → 自动建隐式 task
│   └── client/
│       ├── main.jsx / App.jsx / TaskCard.jsx / Queue.jsx / AddTask.jsx / styles.css
│       └── （TaskCard 增状态徽章：🔵在跑/🟡可能在等你/⚪静默）
└── data/                      # tasks.json / sessions.json / history.json
```

数据落点：事件流在 `~/.commander/events.jsonl`（与项目代码解耦，hook 全局可写）；
任务/会话状态在 `commander/data/*.json`。

## 3. 数据模型增量（在 Dispatch 基础上加字段）

### Session（新增）
```
source: 'hook' | 'scan' | 'manual'   // 来源
claudeSessionId: string              // claude 自己的 session_id（hook/扫描带）
projectName, projectRoot, gitBranch  // 来自 parse-hook.py / sessions-index
liveState: 'running' | 'waiting' | 'idle' | 'completed'  // hook 精确 / 扫描近似
lastEventAt: number                  // 最后事件时间
dismissed: boolean                   // 用户 dismiss 后不再冒出
```

### Task（新增）
```
implicit: boolean                    // 扫描/hook 自动建的隐式任务（1:1 包一个 session）
```

## 4. 事件流（hook → 面板）

### 4.1 hook 落点（最小侵入）
`commander install-hooks` 做两件事（幂等）：
1. 把 `hooks/commander-emit.sh` 链接/复制到 `~/.commander/bin/`
2. 在 `~/.claude/settings.json` 的 Notification / Stop / SessionStart / UserPromptSubmit / SessionEnd
   各追加一条 hook command（**追加，不覆盖现有的 notify-*.sh / vibe-island**）：
   `bash ~/.commander/bin/commander-emit.sh <event_type>`

`commander-emit.sh`：读 stdin JSON → 复用 parse-hook.py 提取字段 → 追加一行 JSONL：
```jsonl
{"ts":..., "type":"waiting", "sid":"...", "root":"/...", "project":"x", "name":"summary", "cwd":"/..."}
```
事件类型映射：Notification(idle_prompt)→waiting、Stop→completed、SessionStart→running、
UserPromptSubmit→running、SessionEnd→closed。

### 4.2 server 消费
- `events.js`：启动时 tail 既有 events.jsonl，然后 `fs.watch` 增量读新行 → 调 ingest
- `ingest.js`：按 `sid` upsert session（更新 liveState/lastEventAt）；若该 session 无归属 task 且未 dismissed → 自动建 implicit task 进队列；completed/waiting 事件触发 `notifyChange()` → ws 推 → 面板自动冒出
- `scanner.js`：启动时 + 每 30s，读所有 sessions-index.json，对**未被 hook 覆盖**的会话用 mtime 启发式补 liveState（§3.1 算法），同样 upsert

### 4.3 去重与优先级
- 同一 claudeSessionId：hook 数据 > 扫描数据（hook 有就不用扫描的近似态）
- 进程扫描仅用于底部状态栏「N 个 claude 在跑」的粗统计，不绑定具体会话

## 5. 排序（在 Dispatch scheduler 上增强）
```
1. P0 置顶（手动任务可设；隐式任务默认 P2）
2. liveState 权重：waiting(🟡) > completed > running(🔵) > idle(⚪)
3. 同档按 lastEventAt / queuedAt 升序（先等先处理）
4. skipCount 降权；dismissed 不参与；defer 未到不参与
```

## 6. 面板增强（复用现有 UI）
- TaskCard 顶部状态徽章：🔵在跑 / 🟡可能在等你 / ⚪静默（颜色复用 priority 样式）
- 元信息行加：项目名 · gitBranch · 距上次活动时长
- 操作键不变：Enter 完成 / S 跳过 / L 稍后；新增 `D`=dismiss（不再冒出）
- 底部状态栏：「N 个 claude 在跑 | 待处理 M | 今日完成 K」

## 7. CLI（commander.js）
```
commander serve [--port 3890] [--open]
commander install-hooks          # 幂等写入 hook + 部署 emit 脚本
commander uninstall-hooks        # 移除 commander 追加的 hook（不动别人的）
commander add / list / done / skip / defer   # 同 dispatch
commander status                 # 终端速查当前队列
```

## 8. 实现步骤（一次性，按序）

1. **迁移**：把 dispatch/ 的 src/bin/vite/package 复制进 commander/，改名 commander，迁 INTEGRATION.md
2. **数据模型**：store/tasks 增字段（source/liveState/dismissed/implicit 等）
3. **events.js + ingest.js**：消费 events.jsonl → upsert session → 建隐式 task → ws 推
4. **scanner.js**：扫 sessions-index.json + 进程，兜底发现（§3.1 启发式）
5. **hooks/commander-emit.sh + install-hooks**：幂等改 ~/.claude/settings.json，复用 parse-hook.py
6. **scheduler 增强**：liveState 权重排序
7. **前端**：状态徽章、项目/分支/时长、D=dismiss、状态栏统计
8. **CLI**：install-hooks/uninstall-hooks/status
9. **串通自测**：装 hook → 真实跑一个 claude 会话 → 完成事件 → 面板自动冒出 → done

## 9. 验收标准
- `commander install-hooks` 后，现有 notify 音效/通知/cmux 不受影响（追加而非覆盖）
- 真实 claude 会话 idle/完成 → 事件写入 events.jsonl → 面板**自动**出现该会话，带 🟡/✓ 状态
- 启动 Commander 即看到历史会话（扫描兜底），按活跃度排序
- Enter 完成 / D dismiss 后不再冒出；重启不丢
- 底部显示「N 个 claude 在跑」

## 10. 风险与对策
| 风险 | 对策 |
|------|------|
| 改坏现有 hook 链 | install-hooks 只**追加** command，先备份 settings.json；uninstall 精确移除 |
| events.jsonl 并发写 | hook 用 `>>` 追加单行（O_APPEND 原子），server 只读 |
| parse-hook.py 依赖 | emit 脚本复用它；若缺失则降级只写 sid+cwd |
| 隐式任务刷屏 | dismissed 持久化；completed 后不因后续 mtime 再冒出（除非有新 waiting 事件） |
| vibe-island/cmux 已占位 | 不冲突，Commander 是并行的第三个消费者，各写各的 |
```
