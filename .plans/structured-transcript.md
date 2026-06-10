# 结构化对话渲染 + 可插拔 Source 架构

## 目标
把 Claude Code 会话从「拍平成文本」升级为「按事件类型结构化渲染」，对齐桌面版观感；同时把渲染管线做成**可插拔**，为后续接入 Codex / 第三方网页(iframe)预留架构。本期**只实现 Claude Code 的结构化渲染 + 搭好插件骨架**，Codex/iframe 下期填。

## 架构：两层分离

```
Commander 外壳（调度层，已有，不动核心）
  队列 / 优先级 / 完成跳过稍后 / 等待时长 / 全局视角 / LLM分析 / 网页续话
        │
        ▼  每张卡片有一个 source.type
  ┌─────────────────────────────────────────────┐
  │  Source 抽象： type ∈ {claude, codex, web}    │
  │   - claude → 解析 jsonl 成统一 EventStream     │
  │   - codex  → (下期) 解析 codex 日志成 EventStream│
  │   - web    → (下期) 直接 iframe URL            │
  └─────────────────────────────────────────────┘
        │ 统一 EventStream
        ▼
  Renderer： EventStream → React 组件
   （claude/codex 共享这一套结构化组件；web 不走这层）
```

## 统一事件结构（后端 transcript.js 产出）

把现在的 `recentMessages: [{seq, role, text, ts}]` 升级为：

```js
// 一条「回合消息」可含多个 part
{
  seq, role: 'user'|'assistant'|'tool', ts,
  parts: [
    { kind: 'text', text },                                 // markdown 文本
    { kind: 'thinking', text },                             // 思考块
    { kind: 'tool_use', id, name, input },                  // 工具调用
    { kind: 'tool_result', toolUseId, content, isError },   // 工具结果
    { kind: 'todos', items:[{content,status}] },            // TodoWrite 特化
  ]
}
```

后端**配对** tool_use.id ↔ tool_result.tool_use_id（已验证 119/119 全配对），把结果挂到对应工具调用上，前端就能渲染「命令+输出」合一的卡片。

向后兼容：保留顶层 `text`（由 parts 拼出）供 LLM 分析、firstMessage 等旧逻辑使用。

## 前端结构化组件（按用户优先级）

新建 `src/client/parts/` 目录，每种事件一个组件：

1. **DiffPart**（Edit/Write）—— 最高优先级
   - Edit：用 `old_string`/`new_string` 算行级 diff，绿/红行内显示；顶部显示 `file_path`
   - Write：显示新建文件 + 内容(高亮)
   - 折叠：默认展开前 ~20 行，长 diff 可展开

2. **BashPart**（Bash）
   - 命令等宽高亮 + `description` 副标题
   - 配对的 tool_result 作为输出，默认折叠（点开看 stdout/stderr），is_error 标红

3. **FilePart**（Read/Grep/Glob/LS）
   - 默认折叠成一行：`📄 Read file_path` / `🔍 Grep pattern`
   - 点开看 tool_result 内容（高亮）

4. **ThinkingPart** + **TodoPart**
   - thinking：浅灰折叠块，默认收起，标「💭 思考」
   - TodoWrite：渲染成勾选清单（completed=✓ / in_progress=◐ / pending=○）

5. **GenericToolPart**（兜底）—— 其它工具(AskUserQuestion/WebFetch/Task*等)
   - `[ToolName]` + 关键 input 字段摘要 + 可展开 raw JSON

6. **TextPart** —— 复用现有 Markdown 组件（已修好换行）

## 依赖（用成熟库）
- **highlight.js**（语法高亮，零配置自动识别，~按需引入语言）— 比 shiki 轻、无需 build step，适合本地工具
- **diff**（jsdiff，~极小）— 算 Edit 的行级 diff
- marked 已装

## 实施步骤

### 后端
1. `transcript.js`：重写 `getSessionContext`，产出带 `parts` 的事件结构 + 配对 tool_use/result。保留 `text` 兼容字段。

### 前端
2. 装依赖：`pnpm add highlight.js diff`
3. 新建 `src/client/parts/` 各组件 + 一个 `MessagePart.jsx` 分发器（按 part.kind 路由到对应组件）
4. `TaskCard.jsx`：`ContextView` 的 `msgs.map` 改为渲染 `<Message msg={m}/>`，Message 内遍历 parts 用 MessagePart 分发
5. `styles.css`：每种 part 的卡片样式（diff 绿红、bash 终端风、折叠交互、todo 清单）

### 插件骨架（本期只搭壳）
6. 卡片数据加 `source: { type:'claude', sessionId, workingDir }`（现有会话默认 claude）
7. ContextView 顶层按 `source.type` 分支：claude → 走结构化渲染；codex/web → 占位「下期支持」。**只留接口，不实现 codex/web**。

### 验证
8. build + 重启 server（牢记：服务端改动必须重启）
9. 浏览器实测：找一个含 Edit/Bash/Read/Todo 的会话，逐一确认四类组件渲染正确、折叠可交互、diff 颜色对、高亮生效

## 不做（本期）
- Codex adapter（需先调研其日志格式）
- 第三方网页 iframe（下期，架构已留位）
- 流式续话回复暂仍用纯 Markdown（结构化只针对历史 transcript；续话是 -p 文本输出，无结构化事件）

## 风险/注意
- highlight.js 全量语言包很大 → 只注册常用语言(js/ts/py/bash/json/css/html/go/rust)
- dangerouslySetInnerHTML 已有 sanitize，高亮输出也需走净化
- 长 tool_result（如读大文件）要截断 + 折叠，避免卡片爆炸
- 服务端模块缓存：改 transcript.js 后必须重启 node 进程（本次已踩过坑）
