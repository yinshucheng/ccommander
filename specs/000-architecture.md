# 000 — 架构基线：调度内核 + Source/Renderer 插件

- **状态**: accepted
- **优先级**: —（基线，所有特性都受其约束）
- **创建**: 2026-06-10
- **依赖**: 无

## 背景 / 动机

Commander 的隐喻是「批阅奏章」：多个 AI 工作实例（Claude Code、未来的 Codex、第三方网页）作为「奏章」汇聚到一个面板，供人审阅与调度。

要支持异构来源，又不能让每接入一个来源就改一遍核心，必须把系统切成两层：**稳定的调度内核** + **可插拔的内容来源/渲染**。本 spec 固化这条边界，后续所有 Source 接入（002、003…）都必须遵守。

## 目标

定义两层架构的职责边界与接口契约，使新增 Source 类型时**不触碰调度内核**。

### 非目标

- 不规定具体某种 Source 的解析细节（那是各自 spec 的事）。
- 不涉及多用户/权限/远程部署。

## 架构

```
┌─────────────────────────────────────────────┐
│  调度内核（Shell）—— 稳定，不随来源变化          │
│  · 队列 / 优先级（P0–P3）                       │
│  · liveState 聚合：waiting🟡>completed✓>running🔵>idle⚪ │
│  · 完成/跳过/延后/忽略                          │
│  · 全局总览、LLM 分析、网页续话                  │
│  · 任务↔Session 聚合                            │
└───────────────┬─────────────────────────────┘
                │  每张卡片携带 source: { type, ... }
                ▼
┌─────────────────────────────────────────────┐
│  Source / Renderer 插件层 —— 按 type 分发        │
│  claude → 解析 jsonl → EventStream → 结构化组件   │
│  codex  → 解析 codex 记录 → EventStream → 同上组件 │  (002)
│  web    → iframe 嵌入 URL                        │  (003)
└─────────────────────────────────────────────┘
```

## 接口契约

### 卡片上的 source 字段

每个 session/卡片携带：

```js
source: {
  type: 'claude' | 'codex' | 'web',
  // claude/codex：
  sessionId?: string,
  workingDir?: string,
  // web：
  url?: string,
}
```

未带 `source` 时默认 `{ type: 'claude' }`（向后兼容）。

### 统一事件结构（claude / codex 共用）

后端把各来源的原生记录归一成「消息数组」，每条消息：

```js
{
  seq: number,        // 连续序号，分页用
  role: 'user' | 'assistant' | 'tool',
  ts: number | null,
  parts: Part[],      // 结构化片段
  text: string,       // parts 拼成的纯文本，兼容 LLM 分析 / firstMessage
}
```

`Part` 的 `kind` ∈ `text | thinking | tool_use | tool_result | todos`。`tool_use` 在后端完成与 `tool_result` 的配对（按 id），结果挂在 `tool_use.result` 上。详见 [001](001-structured-transcript.md)。

### 前端分发

- `SourceView`（`src/client/TaskCard.jsx`）按 `source.type` 分支：
  - `claude` → `ContextView`（结构化渲染）
  - `codex` → 占位（002 落地后替换）
  - `web` → iframe（003 落地后替换）
- `MessagePart`（`src/client/parts.jsx`）按 `part.kind` 分发到具体组件。**claude 与 codex 复用同一套 part 组件**——这是两层架构的最大收益。

## 约束（对后续所有 spec）

1. **不得为某个 Source 在调度内核里加分支**。来源差异只能体现在 Source 层。
2. 新 Source 若是「对话型」（codex），产出统一事件结构，复用 part 组件；若是「页面型」（web），走 iframe，不进事件管线。
3. 后端改动需重启 node 进程才生效（模块缓存），见 001 风险记录。
4. 密钥只存 `~/.commander/config.json`，绝不入库、打印时脱敏。

## 实现记录

- 两层骨架与 claude 路径已由 [001](001-structured-transcript.md) 落地：`SourceView` 分发、`source` 字段、统一事件结构、part 组件全部就位，codex/web 留占位。
