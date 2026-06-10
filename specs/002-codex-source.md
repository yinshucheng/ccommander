# 002 — Codex 会话 Source 适配器

- **状态**: proposed
- **优先级**: ★ 高
- **创建**: 2026-06-10
- **依赖**: [000](000-architecture.md) · [001](001-structured-transcript.md)

## 背景 / 动机

长期目标是把实际工作场景的 AI 实例都汇聚进 Commander。Claude Code 已接通，Codex 是下一个。架构层已预留 `source.type:'codex'` 与占位渲染，本 spec 负责把它接通。

## 目标

新增 Codex Source 适配器：发现 Codex 会话 → 解析其记录 → 归一成 [000](000-architecture.md) 定义的统一事件结构 → **复用现有 part 组件**渲染。

### 非目标

- 不为 Codex 单独写一套渲染组件（必须复用 001 的 part 组件，差异只在解析层）。
- 不实现 Codex 的「续话/dispatch」（先只读展示，续话另议）。

## 需求

- 作为用户，我希望 Codex 的会话像 Claude Code 一样作为卡片出现在面板里，能看到它的工具调用、diff、输出。
- 作为用户，我希望 Codex 卡片的 liveState（在跑/等我/完成/静默）与 Claude 卡片用同一套判定，统一总览。

## 验收标准

- [ ] 能定位本机 Codex 会话记录（路径/格式待调研填入本 spec）
- [ ] 解析器把 Codex 记录映射为统一事件结构（role/parts/text/seq）
- [ ] Codex 的工具调用映射到 `tool_use` + 配对的 `tool_result`
- [ ] `SourceView` 的 codex 分支渲染真实内容（替换占位）
- [ ] 复用 DiffPart/BashPart/FilePart 等组件，无 Codex 专用渲染分支
- [ ] liveState 判定接入 Codex（与 claude 同口径）
- [ ] 至少一个真实 Codex 会话在浏览器渲染正确，无 console error

## 技术方案

### 待调研（先填这里再开工）

1. **Codex 会话存储在哪、什么格式？**（JSONL？SQLite？目录结构？）
2. **事件/消息形状**：如何区分 user / assistant / 工具调用 / 工具结果？工具调用的参数与结果如何关联？
3. **是否有等价于 Claude `tool_use.id` 的配对键？**

### 落点（确认调研后细化）

- 后端：仿 `src/server/transcript.js`，新增 `src/server/codex.js`，导出与 `getSessionContext` 同形的函数，产出统一事件结构。
- 后端：scanner 增加 Codex 会话发现，卡片打 `source:{type:'codex',...}`。
- 前端：`SourceView` 的 codex 分支调对应 context API；part 组件零改动。

## 风险 / 待定

- Codex 记录格式未知，需先做调研 spike，结果回填本 spec 的「待调研」。
- 工具调用语义可能与 Claude 不完全对齐（如无配对 id），需要在解析层兜底。

## 实现记录

（完成后填）
