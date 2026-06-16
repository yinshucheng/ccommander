# 决策记录：竞品分析与定位升级（2026-06-16）

> 触发：研究 slopus/happy 与 multica-ai/multica 两个外部产品，决策 commander 是否还有必要继续做。
> 结论：**继续做，定位升级，时间盒验证**。护城河成立，不是造轮子。

---

## 一、外部参考（竞品）

### slopus/happy — Claude Code/Codex 移动远程控制客户端
- **解决谁的问题**：让人**远程接管**单/多个 agent。`happy claude` 包住原生 `claude`，会话可在 local/remote 模式切换，手机一键接管。
- **机制**：per-tool-call 权限 approve/deny + allow-always 规则 + plan 审批，推送到手机（源码 `packages/happy-cli/src/claude/utils/permissionHandler.ts`，待审批队列存于 `requests[id]`）。多实例视图 `happy-agent list/machines`。E2E 加密（NaCl + AES-256-GCM + Ed25519，`api/encryption.ts`），iOS/Android 已上架。
- **与 commander 的关系**：**对立哲学**。happy 是**侵入式**（包住 claude、接管会话）；commander PRODUCT.md 第二条明确反对这条路（被动观测、不抢方向盘、照常用原生 claude）。happy 覆盖的是"权限审批机制层"，不是 commander 的"注意力调度层"。**不构成覆盖。**

### multica-ai/multica — 把 coding agent 当团队成员的平台
- **解决谁的问题**：让 **agent 自主执行**，人退出回路。分 issue → agent 自己 pick up/写码/报阻塞/更新状态。"No more babysitting"。
- **机制**：squad（leader agent 路由派活）、autopilot（cron/webhook 定时建 issue 自动派活）、租约式 job 调度器（`server/internal/scheduler/manager.go`，claim/heartbeat/retry）。**明确无人工审批门禁**。Go + PG17+pgvector，可自托管。
- **与 commander 的关系**：**反方向**。multica 让人不用管；commander 处理"人被解放后注意力该投哪"。multica 不抢 commander 的活，但代表"减少人逐条干预"的趋势——commander 必须确保自己不是在加重一个正在被弱化的工序（见下方风险）。

### 竞品地图

| | 解决谁的问题 | 范式 | 形态 |
|---|---|---|---|
| **happy** | 让人远程**接管** agent | 侵入式（包住 claude） | 移动端 + E2E 加密 |
| **multica** | 让 **agent 自主**干、人退出 | 自主执行（无审批） | 团队平台（Go/PG） |
| **commander** | 调度**人的注意力**本身 | 被动观测、非侵入、人做判断 | 本地 TUI（统一入口） |

**第三个格子 happy 和 multica 都没占。** commander 不是造轮子。

---

## 二、定位升级（2026-06-16 用户口述，比原 PRODUCT/VISION 更大）

commander 的长期本质不止"调度 AI 会话"，而是 **人的统一任务调度层**：

1. **单线程串行**：让人始终以单线程方式逐个处理任务，对抗上下文切换损耗。"开车时专心开车，调教车时专心调教车。"
2. **调度对象不止 agent**：除了 AI 会话，还能调度**非数字任务**——看一本书、IM 对话、写作。人始终在同一个界面。
3. **必要时才进全局模式**：日常是"专心处理当前这一个"；只在必要时退后一步进入全局，思考哪些优先、哪些不优先。两种模式刻意分离。

> 这是比 happy/multica 都大的命题——它们只调度 agent，commander 调度的是**人的注意力本身**。

### 灵魂：深度为体，密度为用
- "像刷抖音一样刷任务"是**手感**（流畅、顺手、不卡顿），**不是**抖音式被动消费/多巴胺驱动。
- 坚持 MANIFESTO 的 anti-reference：拒绝通知轰炸、红点焦虑、轮询。
- 目标是让人进入**高质量判断状态**，单位时间判断密度高且每次判断有深度——**密度服务于深度，不能反过来用密度牺牲深度**。

---

## 三、风险与护栏（必须主动挑战的）

1. **"人总要做点啥"可能是合理化**：趋势是 agent 越强、人需要做的越少越往高层走。护栏：commander 必须证明它调度的是**高价值判断**，而不是给人造活干。
2. **"像刷抖音"是危险滑坡**：抖音的密度是被动消费密度，不是创造密度。一旦做成滑动反射流，就背叛了"深度为体"。护栏：每次"呈上下一条"前，确保上一条是真判断而非滑过。
3. **不是最高优先级**：用户 #1 目标最可能达标的是 Vibeflow（已逾期上架）、连续 16 周的小红书 IP。commander 必须**时间盒验证**，不能挤占这两个的优先级。

---

## 四、决策

- ✅ **继续做**，定位升级为"人的统一任务调度层"（单线程串行 + 全局模式分离 + 调度对象扩展到非数字任务）。
- ✅ **时间盒验证，不无限做**：用真实使用验证"注意力调度"价值，验不出就收。不再无限写 spec。
- ✅ 竞品 happy / multica 作为**外部参考**记录在此，定位边界已厘清。
- ⚠️ 不抢 Vibeflow 上架 / 小红书的优先级。

---

*记录人：Claude（竞品深拆 + 用户决策）｜日期：2026-06-16*
