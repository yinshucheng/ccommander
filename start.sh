#!/usr/bin/env bash
# Commander ⚡ 一键启动
# 默认贴心：缺 dist 自动构建、未装 hook 自动安装、起服务、开浏览器。
# 用开关精确控制；--no-* 关掉对应默认行为。
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

# ---- --stop：停掉指定 env 的后台进程 ----
if [[ "$DO_STOP" == "1" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      for _ in 1 2 3 4 5 6; do
        if ! kill -0 "$PID" 2>/dev/null; then break; fi
        sleep 0.5
      done
      if kill -0 "$PID" 2>/dev/null; then
        kill -9 "$PID" 2>/dev/null || true
      fi
      echo "✓ 已停止 [$ENV_NAME] 后台进程 (pid $PID)"
    else
      echo "• [$ENV_NAME] pid 文件在但进程已不在 (pid ${PID:-?})，清理"
    fi
    rm -f "$PID_FILE"
  else
    echo "• 没有 [$ENV_NAME] 的后台进程记录（$PID_FILE 不存在）"
  fi
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
  # 已有同 env 的后台进程在跑 → 拒绝（避免重复起 / 端口冲突）
  if [[ -f "$PID_FILE" ]]; then
    EXISTING="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$EXISTING" ]] && kill -0 "$EXISTING" 2>/dev/null; then
      echo "✗ [$ENV_NAME] 已有后台进程在跑 (pid $EXISTING)。先停掉: ./start.sh --stop --env $ENV_NAME" >&2
      exit 1
    fi
    rm -f "$PID_FILE"   # stale pid 文件，清掉
  fi

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
