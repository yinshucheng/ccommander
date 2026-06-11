# 014 — 多特性并行开发工作流（git worktree + 运行隔离）

- **状态**: accepted
- **优先级**: 高
- **作者**: yinshucheng
- **创建**: 2026-06-11
- **依赖**: 011（start.sh 启动正规化）

## 背景 / 动机

Commander 的 `specs/` 里同时躺着多个互相独立的待办特性（Codex 源 002、网页源 003、diff 折叠 004、续话 UX 005…），它们改的是不同文件/模块。希望能**多个 feature 并行推进**：A 特性卡住等实测时，切到 B 特性继续写，互不污染工作区、互不丢进度。

直接在同一个工作目录上反复 `git stash` / 切分支有两个老问题：

1. **切分支会丢上下文**：`dist/`、跑着的 server、浏览器状态全被打断；切回来要重新 build + 重启 + 重新观测。
2. **未提交改动互相缠绕**：当前工作区已经同时压着「Board 重构」（`Board.jsx`/`RailBar.jsx`/`board-group.js` 等未追踪文件）和 transcript 改动，stash 一多就乱。

`git worktree` 天然解决这两点：每个特性一个独立目录 + 独立分支，代码层面零干扰。但 Commander 有**三个运行时约束**会让「同时跑两个 worktree」互相打架，必须先钉死隔离方案，否则 worktree 只隔离了代码、没隔离运行：

| 约束 | 来源 | 并行后果 |
|------|------|----------|
| 端口固定 3890 | `start.sh` `PORT=3890`；`bin/commander.js` 读 `COMMANDER_PORT` 兜底 3890 | 两个 worktree 同时 `serve` 抢端口，第二个起不来 |
| `pkill -f "commander.js serve"` 无差别 | CLAUDE.md「改后端必须重启」 | 重启 A 的 server 会误杀 B 的 server |
| `~/.commander/config.json` 与事件源全局共享 | `config.js` 硬编码 `~/.commander`；hook 是全局的 | 续话模板/API key/事件流是同一份 |

**关键勘察结论（已验证，决定方案极简）**：

- `data/{tasks,sessions,history}.json` 用**仓库内相对路径**（`store.js`：`join(__dirname,'../../data')`）。⟹ **每个 worktree 自带独立 `data/`，队列状态天然隔离，零改动。**
- 端口已可由 `COMMANDER_PORT` env 注入（`bin/commander.js:5`）。⟹ **端口隔离一个环境变量即可，零改代码。**
- `lsof -nP -iTCP:<port> -sTCP:LISTEN` 能精确按端口定位 server PID（已实测）。⟹ **可用「按端口杀」替代 `pkill -f`，不误伤其他 worktree。**
- `~/.commander/config.json` 与 hook 事件源**共享是合理的**：同一个用户、同一套真实 Claude 会话，本就该看到同样的 live 数据。⟹ **本 spec 不隔离它**（隔离反而要改 `config.js`，且没必要）。

⟹ 方案落点：**worktree 隔离代码 + `COMMANDER_PORT` 隔离运行端口 + 一个按端口重启的脚本**，不改任何 server 代码。

## 目标

让「多特性并行开发」成为这个仓库的一等公民流程：

1. 一条命令为某特性开出隔离 worktree（独立目录 + 分支 + 端口），不打断主目录正在跑的东西。
2. 每个 worktree 能独立 `serve` 在专属端口，两个 server 可并存实测，互不抢端口。
3. 重启某个 worktree 的 server 时只杀它自己那个端口的进程，不误伤别的。
4. 把流程、端口约定、合并顺序写进 CLAUDE.md，让任何新 session 读了就能照做。

### 非目标

- **不隔离 `~/.commander/`**（config / API key / 事件源全局共享，符合实际，改了反而引入状态迁移风险）。
- **不引入 CI / 自动化合并**。合并仍是人工 `rebase main` + `pnpm test` + build。
- **不改 server 任何代码**。纯靠现有 `COMMANDER_PORT` env + 脚本编排 + git worktree。
- **不做 worktree 的自动 GC / 定时清理**。用完手动 `wt-rm`。

## 需求

作为开发者，我想为 002（Codex 源）开一个 worktree，在里面 build / serve / 实测，同时主目录的 server 和浏览器状态原封不动；A 卡住时切到为 003 开的 worktree 继续写，两边进度各自独立、互不丢失。

作为开发者，我改了某 worktree 的后端要重启 server，我想只重启**这个**worktree 的 server，不影响其他正在跑的 worktree。

作为接手的新 session，我读 CLAUDE.md 就知道：怎么开 worktree、各特性分配什么端口、做完怎么合并回 main、合并顺序怎么定。

## 验收标准

- [ ] `scripts/wt.sh new <slug>` 能创建 worktree（`.worktrees/<slug>`，分支 `feat/<slug>`，从最新 `origin/main` 起），并打印分配到的端口。
- [ ] `scripts/wt.sh serve [<slug>]` 在当前（或指定）worktree 用其专属端口起服务；`scripts/wt.sh restart` 只按该端口 `lsof` 定位并杀进程后重起，不影响其他端口的 server。
- [ ] `scripts/wt.sh list` 列出所有 worktree、对应分支、分配端口、该端口是否在跑。
- [ ] `scripts/wt.sh rm <slug>` 安全移除 worktree（有未提交/未合并改动时拒绝并提示，需 `--force`）。
- [ ] 同时在两个 worktree `serve`（如 3891 / 3892）能并存，互不抢端口；各自 `data/` 队列互不串。
- [ ] CLAUDE.md 新增「多特性并行开发」小节：worktree 流程 + 端口约定（3890 主，3891+ 按 worktree 递增）+ 合并顺序约定 + 「按端口重启」替代「`pkill -f`」的说明。
- [ ] `.gitignore` 忽略 `.worktrees/`。
- [ ] `pnpm test` 与 `pnpm build` 仍通过（本 spec 不碰被测代码，应天然绿）。

## 技术方案

### 端口分配约定

- **主目录（main 分支）永远用 3890**，与现状一致，hook / 习惯不变。
- **每个 worktree 分配一个 ≥3891 的固定端口**，由 `wt.sh` 在创建时按「现有 worktree 数 + 3891」算出并记进 worktree 内的 `.commander-port` 文件（单行端口号，gitignore）。脚本所有命令读这个文件得到端口，避免硬记。
- 端口仅注入 `COMMANDER_PORT`，不改 `start.sh`/`bin` 默认值。

### `scripts/wt.sh` 命令面

薄层 bash，编排 `git worktree` + `COMMANDER_PORT` + `lsof`。子命令：

```
wt.sh new <slug>        # git worktree add .worktrees/<slug> -b feat/<slug> origin/main
                        #   + 算端口写 .worktrees/<slug>/.commander-port + pnpm install（worktree 需独立 node_modules 软链或安装）
                        #   + 打印「cd .worktrees/<slug> && ../../scripts/wt.sh serve」
wt.sh list              # 遍历 git worktree list，对每个读 .commander-port，lsof 查该端口在跑否
wt.sh serve [<slug>]    # 读当前/指定 worktree 的 .commander-port，COMMANDER_PORT=<port> 起 serve（缺 dist 先 build）
wt.sh restart [<slug>]  # lsof -nP -iTCP:<port> -sTCP:LISTEN 取 PID → kill → serve（只杀这个端口）
wt.sh rm <slug>         # 检查干净度后 git worktree remove；脏则拒绝，提示 --force
```

`restart` 是替代 CLAUDE.md 现有 `pkill -f "commander.js serve"` 的安全版——后者会杀掉所有 worktree 的 server。

### node_modules 策略

worktree 各自需要 `node_modules`。`wt.sh new` 里 `pnpm install`（pnpm 用全局 store + 硬链，多 worktree 装很快、占用小）。`dist/` 同理各 worktree 独立 build（已 gitignore）。

### 合并顺序约定（写进 CLAUDE.md）

特性基本独立，仍约定：

1. 每个 worktree 开工前、合并前各 `git rebase origin/main` 一次，减小漂移。
2. 合并回 main 用 squash 或 rebase（保持现有线性历史风格，看 git log 是线性的）。
3. 若两个特性确实碰了同一核心文件（scheduler/tasks/App.jsx），**先合冲突小的、后合冲突大的**，后者 rebase 吸收前者。
4. 每次合并前在该 worktree 跑 `pnpm test` + `pnpm build` 通过。

### 运行实测策略（回应「运行隔离」的取舍）

- **默认轻流程**：日常各 worktree 只 `pnpm build` / `pnpm test`，不必每个都起 server。
- **需要浏览器实测时**：用 `wt.sh serve` 起在专属端口，可与主目录 3890 并存对比。
- 这样既不强制每条线都搭一套运行环境（成本高），又在需要时能两个 server 并排看效果。

## 任务拆解

1. 写 `scripts/wt.sh`（new / list / serve / restart / rm），`chmod +x`。
2. `.gitignore` 加 `.worktrees/` 和 `.commander-port`。
3. CLAUDE.md 新增「## 多特性并行开发」小节：流程、端口约定、合并顺序、`wt.sh restart` 替代 `pkill` 的说明。
4. 自验：`wt.sh new demo` → 两个 worktree 各 serve 在 3890/389x 并存 → `wt.sh list` 显示状态 → `wt.sh rm demo` 干净移除。
5. `specs/README.md` 目录加一行 014。

## 实现记录

（实现后补：落地的文件 / 提交）
