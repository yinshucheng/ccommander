# 001 — Claude Code 结构化 transcript 渲染

- **状态**: done
- **优先级**: —
- **创建**: 2026-06-10
- **依赖**: [000](000-architecture.md)

## 背景 / 动机

最初把 transcript 压平成纯文本再渲染，工具调用只剩 `[Bash]`/`[tool_result]` 标记，信息密度低、丑，且与 Claude Code 桌面版差距大。需要按事件类型做结构化组件渲染，同时为未来接入 Codex/网页预留插件架构。

## 目标

后端把 jsonl 拆成结构化事件，前端按类型渲染专用组件（diff/终端/折叠块/清单/思考），并搭好 Source/Renderer 插件骨架。

### 非目标

- 不做 Codex 适配器（→ 002）。
- 不做网页 iframe 实嵌（→ 003，仅留骨架）。
- 续话流式回复仍按纯 Markdown 渲染。

## 验收标准

- [x] 后端每条消息产出 `parts`，含 `text/thinking/tool_use/tool_result/todos`
- [x] `tool_use.id ↔ tool_result.tool_use_id` 后端配对，结果挂 `tool_use.result`
- [x] 保留顶层 `text` 兼容字段（LLM 分析 / firstMessage 不受影响）
- [x] Edit/Write → diff 视图（绿增红删 / 写入高亮）
- [x] Bash → 命令语法高亮 + 折叠输出，出错标红
- [x] Read/Grep/Glob/LS → 折叠一行
- [x] thinking 折叠块；TodoWrite → ✓/◐/○ 清单
- [x] 其它工具兜底（GenericToolPart）
- [x] `SourceView` 按 `source.type` 分发，codex/web 占位
- [x] build 干净、浏览器无 console error、实测渲染正确

## 技术方案

见 [000](000-architecture.md) 的接口契约。依赖：`highlight.js`（按需注册 13 种语言）+ `diff`（jsdiff，行级 diff）。

## 实现记录

落地文件：
- `src/server/transcript.js` — `buildParts()` / `partsToText()` / 第二遍 tool_use↔result 配对、吸收独立 tool_result 消息
- `src/client/parts.jsx`（新建）— DiffPart / BashPart / FilePart / ThinkingPart / TodoPart / GenericToolPart / Markdown + `MessagePart` 分发器；引入 github-dark hljs 主题
- `src/client/TaskCard.jsx` — 删除本地 Markdown 改为从 parts.jsx 导入；`SourceView` 插件分发；msgs.map 改为按 parts 渲染
- `src/client/styles.css` — part-card / diff / 终端输出 / todo / source 占位样式

验证：实测 Bash 卡片高亮+折叠展开正常；后端确认 Edit 带 old/new_string、thinking part 正确产出；total 287→246（吸收独立 tool_result）。

偏差 / 后续：
- thinking 文本存在源数据层面的重复字符（ccr/provider 流式问题）→ 拆到 [007](007-thinking-cleanup.md)
- diff 当前全展开上下文 → 折叠优化拆到 [004](004-diff-fold.md)
