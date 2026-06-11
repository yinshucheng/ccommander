---
name: Commander
description: AI 多实例实时指挥台 — 像皇帝批阅奏章一样管理你的 AI 工作流
colors:
  command-blue: "#4f8cff"
  void-bg: "#0e1116"
  panel-surface: "#171b22"
  panel-raised: "#1f242e"
  hairline: "#2a313d"
  ink: "#e6e9ef"
  ink-muted: "#8b94a3"
  signal-red: "#ff5c5c"
  signal-amber: "#ffc24b"
  signal-green: "#4ade80"
  signal-blue: "#5aa9ff"
  console-black: "#0a0d12"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "1px"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
components:
  button-action:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px"
  button-action-done:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  badge-priority:
    textColor: "{colors.signal-red}"
    rounded: "{rounded.sm}"
    padding: "3px 9px"
  input-field:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "9px 11px"
  card-task:
    backgroundColor: "{colors.panel-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "28px 32px"
---

# Design System: Commander

## 1. Overview

**Creative North Star: "The War Room"**

Commander 是一座作战室。一块冷静的暗色大屏汇总全局战况——谁在跑、谁在等、谁卡住了——而你坐镇中央,逐条拍板。整套视觉的职责只有一个:**让局势一眼可读,让该看的那一条自己冒出来**,然后退到一边,把判断留给你。它不是仪表盘,不为你呈现"漂亮的数据";它是指挥席,只回答"此刻该看哪一个,为什么"。

界面是**深空暗底 + 平面分层 + 信号色点睛**。底色是近黑的冷蓝灰(`#0e1116`),面板靠极小的明度阶梯(`#171b22` → `#1f242e`)和一根 1px 发丝线分层,几乎不用阴影——只有当前正在批阅的那张任务卡,才允许一层柔和投影把它从战况墙上托起。色彩是稀缺的:大部分屏幕是中性的暗灰,只有表达**状态与缓急**时,红/琥珀/绿/蓝才点亮。这种克制本身就是宗旨——一件安静的仪器,绝不能成为新的焦虑来源。

它**明确拒绝**:玩具/花哨的 AI 应用(吉祥物、满屏 emoji、什么都圆角到底、渐变文字);繁忙的 SaaS 仪表盘(hero 大数字卡、KPI 瓷砖、千篇一律卡片网格、图表噪音);通知轰炸式工具(角标狂轰、到处红点)——Commander 存在就是为了终结轮询,它自己绝不能制造轮询。

**Key Characteristics:**
- 深空暗底,冷蓝灰中性,信号色稀缺点睛
- 平面分层为默认,投影是例外(仅托起当前焦点卡)
- 一次只呈现一个:全局为排序,焦点永远落在 current 那一条
- 高密度但不拥挤:信息密度服务于"5 秒读懂",不服务于炫技
- 键盘优先、冷静且精准的交互手感

## 2. Colors

中性的暗色战况墙,加一组只在表达状态与缓急时才点亮的信号色——颜色是稀缺资源,不是装饰。

### Primary
- **Command Blue** (`#4f8cff`):指挥台主操作色。聚焦态边框、active tab、复制/分析等主动作按钮、链接、流式光标。它标记"此处可由你操作",出现频率有意压低。

### Secondary — Signal Spectrum(状态/缓急专用)
这四色是**信号色,非装饰色**。它们同时编码任务**优先级**(P0–P3)与会话**实时状态**(waiting/done/running/idle),始终以 ~18% 透明度填底 + 实色文字成对出现。
- **Signal Red** (`#ff5c5c`):P0 最高优先级 / 危险与移除动作 / diff 删除行。最强信号,用得最省。
- **Signal Amber** (`#ffc24b`):P1 / "在等你"(waiting) / 时长统计 / LLM 分析高亮。"该你出场了"的色温。
- **Signal Green** (`#4ade80`):P2 / "已完成"(done) / 连接正常 / diff 新增行 / 用户消息标记。
- **Signal Blue** (`#5aa9ff`):P3 / "在跑"(running) / 稍后(defer)动作。低缓急的活跃态,与 Command Blue 同族但更亮,刻意区分"状态色"与"操作色"。

### Neutral
- **Void BG** (`#0e1116`):应用最底色,也是输入框/代码块的内陷底。整个作战室的"黑屏"。
- **Panel Surface** (`#171b22`):topbar、状态栏、任务卡、队列/弹窗面板的主体面板色。
- **Panel Raised** (`#1f242e`):卡片右栏元信息区、二级动作按钮、输入控件底——比 Surface 高半阶,靠明度而非阴影分层。
- **Hairline** (`#2a313d`):所有边框、分隔线、发丝规则线。1px,永远是这一根。
- **Ink** (`#e6e9ef`):正文与标题主文字色,冷白。
- **Ink Muted** (`#8b94a3`):次级信息、标签、元数据、idle 状态、占位。注意:在 `#171b22` 上对比度约 5.3:1,过 AA 正文线;**不得再调暗**。
- **Console Black** (`#0a0d12`):代码块/diff 块的终端底色,比 Void 更深,模拟"屏幕里的屏幕"。

### Named Rules
**The Color-Is-Information Rule.** 信号色只用于编码状态与缓急,**永不用作纯装饰**。屏幕上任何一抹红/琥珀/绿/蓝都必须能回答"它在告诉我什么状态"。一旦颜色失去含义,整套信号系统的可读性就崩了。

**The Scarce-Accent Rule.** Command Blue 是稀缺的。它标记可操作处,不用来"让界面好看"。任意一屏里,主蓝的覆盖面应远小于 10%——它的稀少,正是它一眼可辨的原因。

## 3. Typography

**Display / Body Font:** 系统原生 sans(`-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui`)——零加载、各平台原生观感,符合"安静的仪器"定位,不引入品牌字体的喧哗。
**Label/Mono Font:** `ui-monospace, SFMono-Regular, Menlo`——用于一切机器事实:命令、路径、sessionId、代码、diff、时长。

**Character:** 单一无衬线家族,靠**字重(400/600/700)与字号**拉层级,而非靠多字体配对。等宽字体是第二嗓音,专门承载"机器说的话",与人读的正文界限分明。这种"一种声音 + 一种机器声音"的二分,本身就是指挥台的秩序感。

### Hierarchy
- **Display** (700, 34px, lh 1):全局视角面板里的总数大字(`ov-num`)等少数统计焦点。整个应用唯一的"大字",克制使用。
- **Title** (700, 24px, lh 1.3):当前任务卡标题(`task-title`)。批阅的主角。两栏布局下降到 18px。
- **Body** (400, 14px, lh 1.6):任务上下文、transcript 正文、按钮文字。长文本(transcript)行宽受卡片左栏约束,自然落在舒适区。
- **Label** (600, 12px, **letter-spacing 1px**, 常 UPPERCASE):区块小标题(`section-label`、`q-section`、`settings-divider`)。轻度全大写 + 字距,用于结构分隔,不滥用为每节眉标。
- **Mono** (400, 12px, lh 1.5):命令/路径/代码/diff/时长。承载所有需要逐字精确的机器事实。

### Named Rules
**The One-Voice Rule.** 只用一个无衬线家族 + 一个等宽家族。**禁止**引入第二款相似的无衬线做"品牌感"——层级永远靠字重和字号解决。

**The Machine-Voice Rule.** 凡是机器产出、需逐字精确的东西(命令、路径、ID、代码、时长),一律走等宽;凡是人读的叙述,一律走无衬线。两种嗓音不混用。

## 4. Elevation

**平面分层为默认,投影是例外。** 深度几乎全靠**色彩明度阶梯**(Void → Surface → Raised)加 1px 发丝线表达,而非阴影。整面战况墙是平的——这让密集信息保持冷静、不浮躁。唯一的例外是**当前焦点**:正在批阅的那张任务卡,允许一层柔和投影把它从墙面托起,以及覆盖层(队列/弹窗)的半透明黑遮罩制造模态层级。

### Shadow Vocabulary
- **Focus Lift** (`box-shadow: 0 8px 40px rgba(0,0,0,0.4)`):仅用于当前任务卡。把"该你批阅的这一条"从平面战况墙托起,是全局唯一的实体投影。
- **Modal Scrim** (`background: rgba(0,0,0,0.4)` / `0.55`):队列面板、弹窗的背景遮罩。压暗战况墙,把注意力收拢到模态层。

### Named Rules
**The Flat-By-Default Rule.** 表面默认是平的,靠明度阶梯和发丝线分层。阴影只授予**唯一的焦点卡**。若你发现自己给第二个元素加投影,停下——它在和焦点抢注意力,而一次只该有一个焦点。

## 5. Components

整体口吻:**冷静且精准**。为高频连续批阅而生——反馈克制但确切,绝不打断节奏,绝不喧哗。

### Buttons
- **Shape:** 中度圆角。动作按钮 10px(`{rounded.lg}`),图标/小按钮 6px(`{rounded.sm}`),复制等微按钮 5px。**绝不超过 14px**。
- **Action(主批阅按钮):** `Panel Raised` 底 + 1px 发丝边 + Ink 文字,padding 14px,字重 600。hover 提亮到 `#283040`,`:active` 时 `transform: scale(0.98)` 给一记"扭扣式"实体回弹。语义动作只在 hover 时点亮自己的信号色边/底:done→绿,skip→琥珀,defer→蓝,dismiss→红且文字转 muted。
- **Primary action(Command Blue 实底):** 复制/发送等少数主动作用实蓝底 + 白字(`copy-btn`、`converse-send`),padding 紧凑。
- **Icon / Ghost:** 透明底 + 发丝边,hover 填 `Panel Raised`。topbar 与次级操作用。

### Chips / Tabs
- **Style:** 透明底 + 发丝边 + muted 文字的胶囊(`tab`、`q-act`、`defer-preset`)。
- **State:** active 时文字转 Ink、边框转 Command Blue、底填 12% 主蓝(`rgba(79,140,255,0.12)`)。选中态靠主蓝点亮,未选中保持安静。

### Badges(优先级 / 实时状态)
- **Style:** 信号色 18% 透明填底 + 实色文字,圆角 6px,padding 3px 9px,字重 700。
- **语义:** 同一套信号色既表 P0–P3,也表 waiting/done/running/idle。**当前实现仅靠色相区分**——见下方 Don't,这是必须补齐非颜色编码的已知缺口。

### Cards / Containers
- **Corner Style:** 任务卡 14px(`{rounded.xl}`),内嵌区块(session-section、part-card)6–10px。
- **Background:** 卡片主体 `Panel Surface`;两栏卡的右栏元信息区用 `Panel Raised` + 左侧 1px 发丝线分栏。
- **Shadow Strategy:** 仅当前焦点卡用 Focus Lift(见 Elevation),其余一律平面。
- **Border:** 统一 1px `Hairline`。

### Inputs / Fields
- **Style:** `Panel Raised` 底 + 1px 发丝边 + 7–8px 圆角。续话输入框整框充当"输入框外观",内部纵向排缩略图 → textarea → 浮动发送按钮。
- **Focus:** 边框转 Command Blue(`border-color: var(--accent)`),无外发光、无 outline。冷静的聚焦反馈。
- **Disabled:** `opacity` 降到 0.45–0.6。

### Navigation / Topbar
- **Style:** `Panel Surface` 底 + 底部 1px 发丝线。左侧多个 ghost 图标按钮,右侧连接状态点(绿=连/红=断)+ 品牌字(700,字距 1px)。

### Signature Component — 任务卡(两栏批阅卡)
Commander 的主角。左栏是会话 transcript(flex 撑高、独立滚动)+ 底部固定的续话输入框;右栏是元信息(优先级/状态徽章、统计、工作目录、操作按钮)。中间一条可拖拽的 6px 分隔条(hover 转主蓝)。这张卡同时是"在读什么"和"能做什么"的全部——奏章本身与朱批工具,合于一处。

## 6. Do's and Don'ts

### Do:
- **Do** 让信号色只承载状态与缓急(The Color-Is-Information Rule)。屏上每一抹红/琥珀/绿/蓝都要能回答"它在说什么状态"。
- **Do** 把主蓝(Command Blue)当稀缺资源,只标记可操作处,任意一屏覆盖面远小于 10%(The Scarce-Accent Rule)。
- **Do** 默认用平面 + 明度阶梯(Void→Surface→Raised)+ 1px 发丝线分层;阴影只给唯一的当前焦点卡(The Flat-By-Default Rule)。
- **Do** 用单一无衬线靠字重/字号拉层级,机器事实(命令/路径/ID/代码/时长)一律走等宽。
- **Do** 让交互"冷静且精准":hover 点亮自身信号色、`:active` scale(0.98) 实体回弹、focus 转主蓝边框,反馈确切但不打断批阅节奏。
- **Do** 为优先级**叠加非颜色编码**(图标/文字标签/形状/位置),照顾红绿色盲——这是 PRODUCT.md 的硬要求。
- **Do** 完整支持 `prefers-reduced-motion`:流式光标 blink、scale 回弹、"下一条自动呈上"的过渡都要有降级(瞬时/淡入)。

### Don't:
- **Don't** 做成玩具/花哨的 AI 应用:禁止吉祥物、满屏 emoji 装饰、什么都圆角到底、**渐变文字**(`background-clip: text`)。
- **Don't** 做成繁忙的 SaaS 仪表盘:禁止 hero-metric 大数字卡模板、KPI 瓷砖、千篇一律的同尺寸卡片网格、图表噪音、渐变点缀。
- **Don't** 做成通知轰炸工具:禁止角标狂轰、到处红点、未读计数——Commander 终结轮询,绝不能成为新的轮询源。
- **Don't** 用色相**单独**编码优先级/状态(当前 `.badge.p0–p3` 仅靠颜色,是必须补齐的缺口)。色弱用户不该因此丢失"谁最紧要"。
- **Don't** 把卡片圆角推到 16px 以上,或引入超过 14px 的容器圆角;徽章/胶囊可全圆,卡片不可。
- **Don't** 给焦点卡之外的元素加投影,更别用 `border: 1px solid` + `box-shadow ≥16px` 的"幽灵卡"组合——平面是默认。
- **Don't** 引入第二款相似的无衬线"做品牌感";层级永远靠字重和字号解决(The One-Voice Rule)。
- **Don't** 在每个区块上方加小号全大写字距眉标当脚手架;`section-label` 是结构分隔,不是每节都要的 kicker。
