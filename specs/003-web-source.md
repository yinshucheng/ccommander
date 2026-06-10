# 003 — 第三方网页 Source（iframe 嵌入）

- **状态**: proposed
- **优先级**: ★ 高
- **创建**: 2026-06-10
- **依赖**: [000](000-architecture.md)

## 背景 / 动机

除 Claude Code / Codex 外，用户希望把任意第三方工作页面也作为「奏章」嵌进面板（如某个 Web 版 AI、看板、日志页）。架构层已预留 `source.type:'web'` 与 iframe 骨架，本 spec 负责把它做成可配置、可用、安全。

## 目标

让用户能添加一个「网页卡片」：填 URL，面板里以 iframe 嵌入展示，纳入统一总览。

### 非目标

- 不解析网页内容、不抽取事件（页面型来源不进事件管线）。
- 不做需要登录态注入/绕过同源策略的复杂集成。

## 需求

- 作为用户，我想新建一张卡片、选择类型「网页」、填入 URL，面板就嵌入该页面。
- 作为用户，我希望能给网页卡片设标题、优先级，和其它卡片一起排队/审阅。

## 验收标准

- [ ] 新建卡片支持选择 `type=web` 并填 URL
- [ ] `SourceView` 的 web 分支用 iframe 渲染该 URL（替换占位）
- [ ] iframe 加 `sandbox` 限制（明确允许项），防止嵌入页面干扰宿主
- [ ] 拒绝/降级处理不可嵌入页面（`X-Frame-Options`/CSP `frame-ancestors` 阻止时给出提示）
- [ ] 网页卡片可设标题与优先级，进入队列与总览
- [ ] 至少一个真实 URL 嵌入展示正常

## 技术方案

- 前端：`SourceView` 已有 `web` 分支与 `.source-iframe` 样式骨架（001 落地）。补：sandbox 属性、加载失败提示。
- 后端：`createTask`/session 数据支持 `source:{type:'web',url}`；网页卡片无 jsonl，liveState 取「idle」或由用户手动标注。
- 新建入口：前端建卡 UI 增加类型选择（claude/web）。

### 安全

- iframe `sandbox="allow-scripts allow-same-origin allow-forms"`（按需收紧；`allow-same-origin`+`allow-scripts` 同时给会削弱沙箱，需评估）。
- URL 仅允许 http/https，过滤 `javascript:` 等。
- 很多站点禁止被 iframe（`X-Frame-Options: DENY`）——检测不到时给「无法嵌入，点此新窗口打开」降级。

## 风险 / 待定

- 大量目标站点禁止 iframe，体验受限；是否需要「新窗口/快照」降级策略待定。
- liveState 对网页卡片无自然信号，先固定 idle 还是允许手动标注待定。

## 实现记录

（完成后填）
