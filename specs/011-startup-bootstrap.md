# 011 — 启动正规化:start.sh 一键拉起 + 通用启动方式

- **状态**: done
- **优先级**: 高
- **作者**: yinshucheng
- **创建**: 2026-06-11
- **依赖**: 无

## 背景 / 动机

现状外部用户从 GitHub clone 后,要跑起来得记一串命令并踩几个坑:

1. **忘记 build → 白屏**。`dist/` 被 gitignore,新 clone 没有;若直接 `serve`,server 虽在日志里提示「前端未构建」(`index.js:67`),但浏览器仍是白屏,新人不知所措。
2. **续话硬绑 ccr**。`config.js` 默认 `cmdTemplate` 是 `ccr code ...`,而外部用户大概率没装 claude-code-router,续话直接失败且无任何提示。
3. **启动入口冗长**。要记 `node bin/commander.js serve --port 3890`,还得另外手动 `install-hooks`,没有一条「拉起来」的命令。
4. **环境前置不明**。无 `engines`/`packageManager`,node/pnpm 版本不匹配时报错晦涩;没装依赖时直接崩。

目标是把「clone → 跑起来」压成一条命令,并让启动方式与续话不再绑死 ccr。

## 目标

外部用户 clone 后,执行 `./start.sh` 一条命令即可:自动构建前端(缺则建)、安装 hook(没装则装)、起服务、开浏览器。续话默认走原生 `claude`,ccr 作为可配置补充。

### 非目标

- **不发 npm 包、不做 npx 化**。本次只做「clone 能跑」,发包是阶段2。
- **不迁移 `data/` 目录**。`store.js` 仍写仓库内 `data/`;迁到 `~/.commander/data` 是发包前置(见下「阶段2 地基坑」),本次不动以免引入未验证的状态迁移。
- **不做开机自启 / 守护进程**(launchd/pm2)。
- **不重写参数解析**。bin 的现有参数面保持,start.sh 只做薄层编排。

## 需求

作为一个刚 clone 仓库的新用户,我想要一条命令把 Commander 跑起来并打开面板,不必记多条命令、不必手动 build、不必猜为什么白屏。

作为老手,我想要用开关精确控制(只起服务、换端口、跳过 build),不被「贴心」行为绑架。

作为本机已用 ccr 的用户,我想要续话默认不被改坏:已有 `~/.commander/config.json` 不被覆盖,且自检能告诉我当前续话走的是哪个命令。

## 验收标准

- [x] 全新 clone(无 `dist/`、无 hook)→ `pnpm install` 后裸跑 `./start.sh`:自动 build → 装 hook → 起服务 → 开浏览器,UI 正常(非白屏)。（脚本逻辑 + 各分支已实测）
- [x] `./start.sh --help` 列出全部开关:`--port`/`--build`/`--no-build`/`--install-hooks`/`--no-install-hooks`/`--open`/`--no-open`。
- [x] `./start.sh --port 4000 --no-open` 起在 4000 且不开浏览器。
- [x] 缺 `node_modules` 或 `pnpm` 不在 PATH 时,start.sh 给出明确中文提示并非 0 退出,而非晦涩报错。
- [x] 不构建直接访问(无 dist)时,浏览器看到「请先构建」提示页(HTTP 503),而非白屏;API 路由不受影响。
- [x] `serve` 启动日志包含自检五项:端口、dist 构建状态、`claude`/`ccr` 是否在 PATH、hook 是否已装;并对续话给出结论(将用哪个命令 + 能否用)。
- [x] 默认 `cmdTemplate` 为 `claude --dangerously-skip-permissions --resume {sessionId}`;已存在的 `~/.commander/config.json` 不被覆盖(实测本机旧 ccr 配置仍生效)。
- [x] `package.json` 含 `engines.node` 与 `packageManager`。
- [x] README「快速开始」更新为 `./start.sh` 一条命令路径,并注明 ccr 为可选补充。
- [x] 一条回归测试覆盖自检纯函数(`test/health.test.mjs`,7 例)。
- [x] 额外:端口占用(EADDRINUSE)给出友好单行提示并退出(实现中发现 wss 重抛 error 的坑并修复)。

## 技术方案

### 1. `start.sh`(仓库根,bash) — 薄层编排

只负责编排,真正逻辑尽量复用 `bin/commander.js`,避免两处参数解析打架。

**默认行为(裸跑 `./start.sh`,贴心模式)**:
1. 前置检查:`pnpm` 在不在 PATH;`node_modules/` 在不在(不在则提示 `pnpm install` 并退出)。
2. dist 缺失 → `pnpm build`(`--no-build` 可关;`--build` 可强制重建)。
3. hook 未装 → `node bin/commander.js install-hooks`(`--no-install-hooks` 可关)。判定「已装」:检查 `~/.claude/settings.json` 是否含 `commander-emit.sh` 标记(与 install-hooks.js 的 TAG 一致)。
4. 起服务:`node bin/commander.js serve --port <port>`。
5. `--open`(默认开):服务 listen 后开浏览器(mac `open` / linux `xdg-open`),`--no-open` 关。

**开关**:
- `--port N`(默认 3890,透传 serve)
- `--build` / `--no-build`(默认:缺 dist 才 build)
- `--install-hooks` / `--no-install-hooks`(默认:未装才装)
- `--open` / `--no-open`(默认 open)
- `-h` / `--help`

**实现要点**:
- `set -euo pipefail`;`cd` 到脚本所在目录(`SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)`)使任意目录调用都正确。
- 「开浏览器」与「serve 前台阻塞」的时序:serve 是前台长进程,不能在它后面再开浏览器。方案:open 时,先后台 sleep+open(`( sleep 1.5; open URL ) &`),再前台 exec serve。
- `chmod +x start.sh`,并在 README 注明。

### 2. 续话默认改原生 claude(`config.js`)

`DEFAULTS.cmdTemplate` 改为:

```js
cmdTemplate: 'claude --dangerously-skip-permissions --resume {sessionId}',
```

`getConfig()` 既有逻辑保证「已存在的 config.json 不被覆盖」(只在文件不存在时写默认),无需改动该路径 —— 仅改默认常量。注释更新:说明默认走原生 claude,ccr 为可选,用户可在 Settings / `~/.commander/config.json` 改 `cmdTemplate`。

### 3. 启动自检(`index.js` 的 `startServer` 内,listen 回调)

新增一个**纯函数** `buildHealthReport({ port, distExists })`(放 `index.js` 或新 `src/server/health.js`,便于测试),返回结构化诊断;listen 回调里打印。检测项:

| 项 | 怎么测 | 输出 |
|----|--------|------|
| 端口 | listen 成功即未占用;失败走 error 事件提示换端口 | `✓ 端口 3890` |
| dist | `existsSync(DIST)` | `✓ 前端已构建` / `⚠ 未构建,运行 pnpm build` |
| claude | `which claude`(`child_process.spawnSync('which',['claude'])`,或跨平台用 `command -v`) | `✓ claude 可用` / `⚠ claude 不在 PATH` |
| ccr | 同上测 `ccr` | `✓ 检测到 ccr(如需走代理可在 Settings 切换 cmdTemplate)` / 静默 |
| hook | `~/.claude/settings.json` 含 TAG | `✓ hook 已安装` / `⚠ 未安装,运行 install-hooks` |
| 续话结论 | 解析当前 `cmdTemplate` 首词,核对该命令是否在 PATH | `续话将用: claude …(可用 ✓ / 不可用 ⚠)` |

`which/command -v` 检测封成小工具函数 `isOnPath(bin)`,便于测试与复用。

### 4. dist 缺失友好页(`index.js`)

当前 `if (existsSync(DIST))` 才挂 static;否则什么都不挂 → 白屏。改为 else 分支挂一个 catch-all,返回内联 HTML:

```js
} else {
  app.get('*', (req, res) =>
    res.status(503).send('<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:3rem">' +
      '<h1>⚡ Commander 前端尚未构建</h1><p>请先运行 <code>pnpm build</code>(或用 <code>./start.sh</code> 自动构建),然后刷新本页。</p>'))
}
```

API 路由在此 catch-all 之前注册,不受影响。

### 5. 版本锁与 README(`package.json` / `README.md`)

`package.json` 增:

```json
"engines": { "node": ">=20" },
"packageManager": "pnpm@11.1.3"
```

(node 阈值按现有语法/依赖取 ≥20;`packageManager` 锁当前 pnpm。)

README「快速开始」改为:

```bash
pnpm install
./start.sh              # 自动构建 + 装 hook + 起服务 + 开浏览器
# 老手:./start.sh --port 4000 --no-open --no-install-hooks
```

并加一句:续话默认用原生 `claude`;若你用 claude-code-router,在 Settings 把 `cmdTemplate` 改成 `ccr code --dangerously-skip-permissions --resume {sessionId}`。

### 与架构的对接

全部改动在「启动/编排」与「config 默认值」层,**不触碰调度内核(scheduler/tasks)与 Source/Renderer 边界**,符合 `000-architecture.md`。自检为只读探测,无副作用。

## 任务拆解

1. `config.js`:改 `DEFAULTS.cmdTemplate` 默认为原生 claude + 更新注释。
2. `index.js`:抽 `isOnPath()` + `buildHealthReport()`(纯函数);listen 回调打印自检五项 + 续话结论;dist 缺失改为返回提示页。
3. `start.sh`:写薄层编排脚本(默认贴心 + 四组开关 + 前置检查 + open 时序),`chmod +x`。
4. `package.json`:加 `engines` / `packageManager`。
5. `README.md`:更新「快速开始」+ ccr 可选说明。
6. `test/`:为 `buildHealthReport` / `isOnPath` 写一条回归断言(`node --test`)。
7. 手动验证:全新视角模拟(临时移走 dist)跑 `./start.sh`,核对自检输出与浏览器结果;改后端记得 `pkill + 重启 node`。

## 风险 / 待定

- **start.sh 仅 mac/linux**。Windows 用户走 `node bin/commander.js serve`;README 注明。可接受(本次非目标含跨平台脚本)。
- **`--dangerously-skip-permissions` 默认开**:用户已确认采用「默认跳过权限」。安全提示写进 README,不强制。
- **自检的 `which claude`**:某些 shell 环境 PATH 与 GUI 启动不同,可能误报「claude 不在 PATH」。仅作提示、不阻断启动,影响有限。
- **open 时序**:固定 sleep 1.5s 是经验值;若机器慢可能浏览器先于 listen 打开(刷新即可)。可接受。

## 阶段2 地基坑(本次不做,登记备忘)

发 npm 包 / 全局安装前**必须**先解决,否则装进 `node_modules` 后状态写入会出问题:

- `store.js` 的 `DATA_DIR`(现 `../../data`,仓库内)迁到 `~/.commander/data` —— 全局包目录通常只读/升级会被覆盖。需配套一次性迁移(老 `data/` → 新路径)。
- `package.json` 加 `files` 白名单(只发 `bin`/`src`/`dist`/`hooks`),npx 化校验 bin 不依赖仓库结构。
- 另开 spec 012 承接。

## 实现记录

落地文件：
- `start.sh`（新增，`chmod +x`）— 薄层编排:前置检查 → 缺/强制 build → 未装/强制装 hook → 后台延时开浏览器 → 前台 `exec serve`。`--no-*` 关默认行为。
- `src/server/config.js` — `DEFAULTS.cmdTemplate` 改为原生 `claude --dangerously-skip-permissions --resume {sessionId}`,注释说明 ccr 切换方式。
- `src/server/index.js` — 新增并导出纯函数 `isOnPath()` / `buildHealthReport()`;内部 `isHookInstalled()`;listen 回调打印自检五项 + 续话结论;dist 缺失返回 503 提示页(else 分支,在 API 路由之后注册);`server`+`wss` 双挂 EADDRINUSE 友好处理。
- `package.json` — 加 `engines.node >=20`、`packageManager pnpm@11.1.3`。
- `README.md` — 快速开始改为 `./start.sh` 一条命令 + ccr 可选切换说明 + Windows 回退命令。
- `test/health.test.mjs`（新增,7 例)— 钉住自检报告在缺 dist/hook/续话命令不可用时给出告警的不变量。
- `specs/README.md` — 目录登记 011。

与原方案的偏差：
- 把 `buildHealthReport`/`isOnPath` 直接放进 `index.js` 并 export(未另起 `health.js`),因 import index.js 仅执行 import、不触发 `startServer`,测试可安全引入,省一个文件。
- 实现期发现一个原方案没预见的 bug:`new WebSocketServer({ server })` 会把 listen 的 EADDRINUSE 在 `wss` 上重新 emit,而 `wss` 无 error 监听 → Node 当未捕获异常抛堆栈。已通过给 `server` 与 `wss` 都挂同一处理器修复,并人工复现验证(占用端口 → 友好单行提示 + exit 1,主服务不受影响)。

阶段2(发包地基,见下)未做,待 spec 012。

### 对抗式审查修复(实现后追加)

一轮敌意审查打穿了 5 处,均已复现确认 + 修复 + 加回归断言:

1. **isOnPath 命令注入/误报**(`index.js`)— 旧实现 `sh -c "command -v $bin"` 会因 `command -v "x; printf y"` 中 printf 存在而误返回 true。改为不经 shell、只接受 `^[A-Za-z0-9._-]+$` 的 token 并自行遍历 `$PATH` 查可执行文件。注:输入源是本机自有 config,非提权漏洞,但「把不存在的续话命令报成可用 ✓」是实打实的误报。回归:`health.test.mjs` 加元字符输入断言。
2. **缺 cmdTemplate 字段的老配置被静默升级**(`config.js`)— `{...DEFAULTS,...parsed}` 下,改了已有字段的默认值会让「文件存在但缺该字段」的老用户从 ccr 静默切到 claude。修:仅首次创建用新默认;文件已存在但缺 `cmdTemplate` 时回退 `LEGACY_CMD_TEMPLATE`(ccr)。回归:`config-cmdtemplate.test.mjs`(子进程+独立 HOME)。
3. **构建分支缺 pnpm 仍硬崩**(`start.sh`)— pnpm 检查原本只在「缺 node_modules」分支;`--build`/缺 dist 时直接 `pnpm build` → command not found。修:抽 `WILL_BUILD`,执行 `pnpm build` 前统一校验 pnpm。
4. **`--port` 缺值触发 set -u 崩溃**(`start.sh`)— 修:进入 `--port` 分支先查 `$#`。
5. **非法端口吐 Node 堆栈**(`bin/commander.js` + `start.sh`)— `serve --port abc` → `Number(...)=NaN` → `listen` 在挂 error 监听前同步抛 `ERR_SOCKET_BAD_PORT`。修:CLI 与脚本两层都先校验端口为 1..65535 整数。

审查另指出的元观察(#6:测试只覆盖纯函数、未覆盖 listen 回调接线)已部分回应——补了 isOnPath 与 config 的真实输入测试;listen 回调的端到端仍靠人工复现验证。测试总数 39 → 43。
