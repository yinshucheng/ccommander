#!/usr/bin/env bash
# Commander ⚡ 一键启动
# 默认贴心：缺 dist 自动构建、未装 hook 自动安装、起服务、开浏览器。
# 用开关精确控制；--no-* 关掉对应默认行为。
#
# 幂等重启：启动前会清掉该端口上的 commander 旧进程（前台/后台都覆盖），
# 所以「改了后端代码 → 重跑同一条 start.sh」就能自动换新进程，不用手动 kill。
# 非 commander 进程占着端口则不误杀，会报冲突让你手动处理。
#
# 后台模式（--background / --bg / -d）：把服务 detach 到后台，stdout/stderr
# 写进 /tmp 下按 --env 命名的日志文件，并落 pid 文件。终端关了服务也不死，
# 你可以 `tail -f /tmp/commander-<env>.log` 自己看，或让 AI 工具读这个固定路径。
#   ./start.sh --background --env prod        # 起：日志 /tmp/commander-prod.log
#   ./start.sh --stop --env prod              # 停
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT=3890
BUILD=auto          # auto=缺则构建 | force | skip
HOOKS=auto          # auto=未装则装 | force | skip
OPEN=1
BACKGROUND=0        # 0=前台(exec) | 1=后台(nohup + 日志)
ENV_NAME="main"     # 后台日志/pid 文件的环境标识
LOG_FILE=""         # 显式指定则覆盖 --env 推导的日志路径
DO_STOP=0           # --stop：停掉指定 env 的后台进程

# ---- 进程管理辅助（幂等重启靠端口定位，与 wt.sh 同套路）----
# 端口上的 LISTEN pid 列表（空=没在跑）。lsof 不存在时回退 pgrep。
pids_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
  else
    pgrep -f "commander.js serve --port $port" 2>/dev/null || true
  fi
}

# 判断某 pid 是不是 commander server（按命令行匹配，避免误杀同端口的别的进程）
is_commander_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -q "commander.js serve"
}

# 杀某 pid：TERM → 等 ≤3s → 仍活则 KILL。不报错（进程可能已退）。
kill_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

# 释放端口：杀掉该端口上的 commander 旧进程（前台/后台都覆盖）。
# 非 commander 进程占着端口则不动（返回失败，让上层报端口冲突）。
# 返回 0=已清干净（或本来就空），1=有非 commander 进程挡路。
free_port() {
  local port="$1" killed=""
  local pids; pids="$(pids_on_port "$port")"
  [[ -z "$pids" ]] && return 0
  local p
  for p in $pids; do
    if is_commander_pid "$p"; then
      kill_pid "$p"
      killed="$killed $p"
    else
      return 1   # 非 commander 进程占着，不误杀
    fi
  done
  [[ -n "$(pids_on_port "$port")" ]] && return 1
  [[ -n "${killed// /}" ]] && echo "$killed"
  return 0
}

usage() {
  cat <<'EOF'
Commander ⚡ — 一键启动

用法: ./start.sh [选项]

  --port <N>            服务端口（默认 3890）
  --build               强制重新构建前端
  --no-build            跳过构建（无 dist 时浏览器会看到提示页）
  --install-hooks       强制（重新）安装 Claude Code hook
  --no-install-hooks    跳过 hook 安装
  --open / --no-open    起服务后是否自动开浏览器（默认开）

后台模式：
  --background, --bg, -d   后台运行（detach），输出写进 /tmp 日志文件
  --env <name>            环境标识，决定日志/pid 文件名（默认 main）
                          → /tmp/commander-<name>.log 与 .pid
  --log-file <path>       显式指定日志文件（覆盖 --env 推导）
  --stop [--env <name>]   停掉该 env 的后台进程（默认 main）

  -h, --help            显示本帮助

裸跑 `./start.sh`：缺 dist 自动构建 + 未装 hook 自动安装 + 起服务 + 开浏览器（前台）。
后台：`./start.sh --background --env prod`，日志在 /tmp/commander-prod.log。
幂等：重跑同一条命令会自动杀掉端口上的旧 commander 再起新的（改了后端重跑即可，不用手动 kill）。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      if [[ $# -lt 2 ]]; then echo "✗ --port 需要一个端口号，例如 --port 3890" >&2; exit 1; fi
      PORT="$2"; shift 2 ;;
    --build) BUILD=force; shift ;;
    --no-build) BUILD=skip; shift ;;
    --install-hooks) HOOKS=force; shift ;;
    --no-install-hooks) HOOKS=skip; shift ;;
    --open) OPEN=1; shift ;;
    --no-open) OPEN=0; shift ;;
    --background|--bg|-d) BACKGROUND=1; shift ;;
    --env)
      if [[ $# -lt 2 ]]; then echo "✗ --env 需要一个名称，例如 --env prod" >&2; exit 1; fi
      ENV_NAME="$2"; shift 2 ;;
    --log-file)
      if [[ $# -lt 2 ]]; then echo "✗ --log-file 需要一个路径" >&2; exit 1; fi
      LOG_FILE="$2"; shift 2 ;;
    --stop) DO_STOP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ 未知选项: $1" >&2; usage; exit 1 ;;
  esac
done

# ---- 后台日志/pid 路径（按 env 命名，固定在 /tmp 下）----
PID_FILE="/tmp/commander-${ENV_NAME}.pid"
if [[ -z "$LOG_FILE" ]]; then
  LOG_FILE="/tmp/commander-${ENV_NAME}.log"
fi

# ---- --stop：停掉指定 env 的服务（pid 文件优先，回退端口定位）----
if [[ "$DO_STOP" == "1" ]]; then
  STOPPED=""
  # 1) pid 文件里的后台进程
  if [[ -f "$PID_FILE" ]]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      kill_pid "$PID"
      echo "✓ 已停止 [$ENV_NAME] 后台进程 (pid $PID)"
      STOPPED=1
    else
      echo "• [$ENV_NAME] pid 文件在但进程已不在 (pid ${PID:-?})，清理"
    fi
    rm -f "$PID_FILE"
  fi
  # 2) 回退：端口上还残留的 commander（前台起的 / pid 文件丢失的）
  REMAIN_PIDS="$(pids_on_port "$PORT")"
  if [[ -n "$REMAIN_PIDS" ]]; then
    for p in $REMAIN_PIDS; do
      if is_commander_pid "$p"; then
        kill_pid "$p"
        echo "✓ 已停止端口 $PORT 上的 commander (pid $p)"
        STOPPED=1
      fi
    done
  fi
  [[ -n "$STOPPED" ]] || echo "• [$ENV_NAME] 没有在跑的 commander（端口 $PORT 无监听）"
  exit 0
fi

# ---- 校验端口 ----
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "✗ 端口非法: '$PORT'（需 1..65535 的整数）" >&2; exit 1
fi

# ---- 前置检查 ----
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node。请先安装 Node.js (>=20)。" >&2; exit 1
fi
if [[ ! -d node_modules ]]; then
  echo "✗ 缺少依赖。请先运行: pnpm install" >&2
  command -v pnpm >/dev/null 2>&1 || echo "  （也未找到 pnpm，请先安装 pnpm）" >&2
  exit 1
fi

# ---- 构建 ----
WILL_BUILD=0
if [[ "$BUILD" == "force" || ( "$BUILD" == "auto" && ! -d dist ) ]]; then
  WILL_BUILD=1
fi
if [[ "$WILL_BUILD" == "1" ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "✗ 需要构建前端但未找到 pnpm。请安装 pnpm 后重试，或用 --no-build 跳过构建。" >&2
    exit 1
  fi
  echo "▶ 构建前端…"
  pnpm build
fi

# ---- 安装 hook ----
hook_installed() {
  [[ -f "$HOME/.claude/settings.json" ]] && grep -q "commander-emit.sh" "$HOME/.claude/settings.json"
}
DO_HOOKS=0
if [[ "$HOOKS" == "force" ]]; then
  DO_HOOKS=1
elif [[ "$HOOKS" == "auto" ]] && ! hook_installed; then
  DO_HOOKS=1
fi
if [[ "$DO_HOOKS" == "1" ]]; then
  echo "▶ 安装 Claude Code hook（追加，不覆盖现有）…"
  node bin/commander.js install-hooks
fi

# ---- 幂等重启：启动前清掉端口上的 commander 旧进程（前台/后台都覆盖）----
# 「改了后端代码 → 重跑同一条 start.sh」就能自动换新进程，不用手动 kill。
# 非 commander 进程占着端口则不误杀，报端口冲突让你手动处理。
OLD_PIDS="$(free_port "$PORT")" || {
  echo "✗ 端口 $PORT 被非 commander 进程占用，未自动清理（避免误杀）：" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 2>/dev/null || true
  exit 1
}
if [[ -n "$OLD_PIDS" ]]; then
  echo "▶ 端口 $PORT 有旧 commander，已停掉 (pid${OLD_PIDS})，换新进程…"
  # 清掉对应的 stale pid 文件（若旧的是后台进程留下来的）
  [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
fi

# ---- 开浏览器（后台等服务就绪）----
if [[ "$OPEN" == "1" ]]; then
  URL="http://localhost:${PORT}"
  ( sleep 1.5
    if command -v open >/dev/null 2>&1; then open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
    fi ) >/dev/null 2>&1 &
fi

# ---- 起服务 ----
if [[ "$BACKGROUND" == "1" ]]; then
  # 追加一条分隔头，便于区分多次启动（保留历史，不截断）
  {
    echo ""
    echo "=== Commander 启动 $(date '+%Y-%m-%d %H:%M:%S')  env=$ENV_NAME  port=$PORT ==="
  } >> "$LOG_FILE"

  echo "▶ 后台启动… 日志: $LOG_FILE"
  nohup node bin/commander.js serve --port "$PORT" >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"

  # 等 1.5s 确认没立刻挂掉（端口占用 / 配置错误等），挂了就把日志末尾打出来
  sleep 1.5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ 后台进程启动后立刻退出，日志末尾：" >&2
    tail -n 30 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi

  echo "✓ [$ENV_NAME] 后台运行中  pid $SERVER_PID  →  http://localhost:$PORT"
  echo "  日志: $LOG_FILE"
  echo "  pid:  $PID_FILE"
  echo "  停止: ./start.sh --stop --env $ENV_NAME"
else
  # 前台：直接 exec，输出到当前终端
  exec node bin/commander.js serve --port "$PORT"
fi
