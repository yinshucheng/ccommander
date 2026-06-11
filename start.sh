#!/usr/bin/env bash
# Commander ⚡ 一键启动
# 默认贴心：缺 dist 自动构建、未装 hook 自动安装、起服务、开浏览器。
# 用开关精确控制；--no-* 关掉对应默认行为。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT=3890
BUILD=auto          # auto=缺则构建 | force | skip
HOOKS=auto          # auto=未装则装 | force | skip
OPEN=1

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
  -h, --help            显示本帮助

裸跑 `./start.sh`：缺 dist 自动构建 + 未装 hook 自动安装 + 起服务 + 开浏览器。
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
    -h|--help) usage; exit 0 ;;
    *) echo "✗ 未知选项: $1" >&2; usage; exit 1 ;;
  esac
done

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

# ---- 起服务（前台）----
exec node bin/commander.js serve --port "$PORT"
