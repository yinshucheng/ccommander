# Specs — Commander 规格驱动开发

本目录是 Commander 的**单一事实来源（source of truth）**。每个特性在动手写代码前，先在这里写一份 spec：把「要做什么、做到什么算完成、怎么做、拆成哪几步」想清楚并定稿，再实现。

## 为什么 spec 驱动

- Commander 的核心是「调度内核 + 可插拔 Source/Renderer」。内核要长期稳定，新接入（Codex、网页…）必须先对齐接口契约，否则插件会污染内核。
- 会话经常被压缩/中断。spec 是跨 session 的锚点：任何一个新 session 读 `specs/` 就能接上下文，不依赖对话记忆。
- 验收标准前置，避免「做完了但不是想要的」。

## 工作流

1. **提案**：复制 `TEMPLATE.md` → `specs/NNN-<slug>.md`，状态填 `proposed`。编号三位数递增。
2. **定稿**：补齐需求、验收标准、技术方案、任务拆解。与用户确认后状态改 `accepted`。
3. **实现**：按「任务拆解」逐项做；过程中的临时实现笔记放 `.plans/`（短期、可丢弃），spec 本身只记最终决策。
4. **完成**：全部验收标准勾掉后，状态改 `done`，在「实现记录」里留下落地的文件/提交。
5. **变更**：已 `done` 的 spec 若要改，不直接覆写——新开一份 spec 引用它（`Supersedes: NNN`），保留演进轨迹。

## 状态约定

| 状态 | 含义 |
|------|------|
| `proposed` | 已登记，尚未细化/确认 |
| `accepted` | 已定稿，可以开工 |
| `in-progress` | 正在实现 |
| `done` | 已落地并通过验收 |
| `superseded` | 被更新的 spec 取代 |

## 目录

| 编号 | 标题 | 状态 | 优先级 |
|------|------|------|:---:|
| [000](000-architecture.md) | 架构基线：调度内核 + Source/Renderer 插件 | accepted | — |
| [001](001-structured-transcript.md) | Claude Code 结构化 transcript 渲染 | done | — |
| [002](002-codex-source.md) | Codex 会话 Source 适配器 | proposed | ★ 高 |
| [003](003-web-source.md) | 第三方网页 Source（iframe 嵌入） | proposed | ★ 高 |
| [004](004-diff-fold.md) | Diff 上下文折叠 | proposed | 中 |
| [005](005-converse-ux.md) | 续话不自动切卡片 | proposed | 中 |
| [006](006-persistence.md) | 任务状态持久化与一致性 | proposed | 中 |
| [007](007-thinking-cleanup.md) | thinking 重复字符清洗 | proposed | 低 |
| [008](008-two-column-taskcard.md) | TaskCard 两栏布局：左历史 / 右元信息+操作 | done | 中 |
| [009](009-queue-semantics-and-panel.md) | 队列语义修正 + 面板能力增强 + 空会话过滤 | done | ★ 高 |
| [010](010-converse-multiturn-clarify.md) | 续话支持多轮澄清（权限 skip 兜底） | done | ★ 高 |
| [011](011-startup-bootstrap.md) | 启动正规化：start.sh 一键拉起 + 通用启动方式 | done | ★ 高 |
| [014](014-parallel-feature-workflow.md) | 多特性并行开发工作流：git worktree + 运行隔离 | accepted | ★ 高 |

> 编号 ≠ 实现顺序。优先级见上表，实际排期由用户定。

## 相关文档

- `docs/VISION.md` `docs/PRD.md` — 产品愿景与需求（上游，变动慢）
- `DESIGN.md` `PLAN_COMMANDER.md` `INTEGRATION.md` — 总体设计与集成说明
- `.plans/` — 实现期的临时笔记（短期、可丢）
