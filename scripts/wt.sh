#!/usr/bin/env bash
# wt.sh — 多特性并行开发：git worktree + 按端口隔离运行
# 见 specs/014-parallel-feature-workflow.md
#
# 用法：
#   scripts/wt.sh new <slug>        创建 worktree（.worktrees/<slug>，分支 feat/<slug>，从 origin/main 起）
#   scripts/wt.sh list              列出所有 worktree、分支、分配端口、该端口是否在跑
#   scripts/wt.sh serve [<slug>]    在当前/指定 worktree 的专属端口起服务（缺 dist 先 build）
#   scripts/wt.sh restart [<slug>]  只杀该 worktree 端口的 server 后重起（替代无差别的 pkill -f）
#   scripts/wt.sh rm <slug>         安全移除 worktree（脏则拒绝，需 --force）
#
# 端口约定：主目录(main) 永远 3890；每个 worktree 分配 ≥3891 的固定端口，记在
# 该 worktree 的 .commander-port 文件里（gitignore）。
set -euo pipefail

# 定位主仓库根（脚本所在目录的上一级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WT_DIR="$MAIN_ROOT/.worktrees"
BASE_PORT=3891   # worktree 从这里起；3890 留给主目录

die() { echo "✗ $*" >&2; exit 1; }

# 读某目录的 .commander-port；没有则空
port_of() {
  local dir="$1"
  [[ -f "$dir/.commander-port" ]] && cat "$dir/.commander-port" || true
}

# 某端口是否有 LISTEN 进程，回显 PID（空=没在跑）
pid_on_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

# 算下一个可用端口：BASE_PORT + 已有 worktree 数，遇占用顺延
next_port() {
  local n; n="$BASE_PORT"
  while :; do
    local used=""
    if [[ -d "$WT_DIR" ]]; then
      for d in "$WT_DIR"/*/; do
        if [[ -f "$d/.commander-port" && "$(cat "$d/.commander-port")" == "$n" ]]; then
          used=1
        fi
      done
    fi
    if [[ -z "$used" ]]; then echo "$n"; return; fi
    n=$((n + 1))
  done
}

# 找「当前所在 worktree」根；不在 worktree 里则空
current_wt_root() {
  local cwd; cwd="$(pwd)"
  case "$cwd" in
    "$WT_DIR"/*)
      # .worktrees/<slug>/... → 取到 slug 那一层
      local rel="${cwd#"$WT_DIR"/}"
      echo "$WT_DIR/${rel%%/*}" ;;
    *) true ;;
  esac
}

# 把 slug/无参 解析成 worktree 根目录
resolve_root() {
  local slug="${1:-}"
  if [[ -n "$slug" ]]; then
    [[ -d "$WT_DIR/$slug" ]] || die "worktree 不存在: ${slug}（先 wt.sh new $slug）"
    echo "$WT_DIR/$slug"
  else
    local r; r="$(current_wt_root)"
    [[ -n "$r" ]] || die "当前不在某个 worktree 里，请指定 slug（或 cd 进 .worktrees/<slug>）"
    echo "$r"
  fi
}

_build_if_needed() {
  local dir="$1"
  if [[ ! -d "$dir/node_modules" ]]; then
    echo "→ 安装依赖（pnpm install）…"
    ( cd "$dir" && pnpm install )
  fi
  if [[ ! -d "$dir/dist" ]]; then
    echo "→ 构建前端（pnpm build）…"
    ( cd "$dir" && pnpm build )
  fi
}

_serve() {
  local dir="$1" port="$2"
  _build_if_needed "$dir"
  echo "⚡ serve $dir  →  http://localhost:$port"
  ( cd "$dir" && COMMANDER_PORT="$port" exec node bin/commander.js serve --port "$port" )
}

cmd_new() {
  local slug="${1:-}"
  [[ -n "$slug" ]] || die "用法: wt.sh new <slug>"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "slug 只能用小写字母/数字/.-_，且以字母数字开头"
  [[ ! -d "$WT_DIR/$slug" ]] || die "worktree 已存在: $slug"

  echo "→ 拉取 origin/main 最新…"
  ( cd "$MAIN_ROOT" && git fetch origin main --quiet )

  local branch="feat/$slug" base="origin/main"
  echo "→ git worktree add .worktrees/$slug -b $branch $base"
  ( cd "$MAIN_ROOT" && git worktree add "$WT_DIR/$slug" -b "$branch" "$base" )

  local port; port="$(next_port)"
  echo "$port" > "$WT_DIR/$slug/.commander-port"
  echo "→ 分配端口: ${port}（已写入 .commander-port）"

  echo "→ 安装依赖（pnpm install）…"
  ( cd "$WT_DIR/$slug" && pnpm install )

  cat <<EOF

✓ worktree 就绪
  目录:   .worktrees/$slug
  分支:   $branch
  端口:   $port

  开工：
    cd .worktrees/$slug
    ../../scripts/wt.sh serve          # 起服务在 ${port}（缺 dist 自动 build）
    ../../scripts/wt.sh restart        # 改后端后只重启这个 server
EOF
}

cmd_list() {
  printf "%-24s %-22s %-6s %s\n" "WORKTREE" "BRANCH" "PORT" "RUNNING"
  printf "%-24s %-22s %-6s %s\n" "main (此仓库)" "main" "3890" "$([[ -n "$(pid_on_port 3890)" ]] && echo "● pid $(pid_on_port 3890)" || echo "-")"
  [[ -d "$WT_DIR" ]] || { echo "(无 worktree)"; return; }
  for d in "$WT_DIR"/*/; do
    [[ -d "$d" ]] || continue
    local slug; slug="$(basename "$d")"
    local branch; branch="$(cd "$d" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    local port; port="$(port_of "$d")"
    local run="-"
    [[ -n "$port" && -n "$(pid_on_port "$port")" ]] && run="● pid $(pid_on_port "$port")"
    printf "%-24s %-22s %-6s %s\n" "$slug" "$branch" "${port:-?}" "$run"
  done
}

cmd_serve() {
  local root; root="$(resolve_root "${1:-}")"
  local port; port="$(port_of "$root")"
  [[ -n "$port" ]] || die "$root 缺 .commander-port"
  local existing; existing="$(pid_on_port "$port")"
  [[ -z "$existing" ]] || die "端口 $port 已被 pid $existing 占用（用 wt.sh restart 重起，或换 worktree）"
  _serve "$root" "$port"
}

cmd_restart() {
  local root; root="$(resolve_root "${1:-}")"
  local port; port="$(port_of "$root")"
  [[ -n "$port" ]] || die "$root 缺 .commander-port"
  local existing; existing="$(pid_on_port "$port")"
  if [[ -n "$existing" ]]; then
    echo "→ 杀掉端口 $port 上的 server (pid $existing)…"
    kill "$existing" 2>/dev/null || true
    # 等它退出，最多 ~3s
    for _ in 1 2 3 4 5 6; do
      [[ -z "$(pid_on_port "$port")" ]] && break
      sleep 0.5
    done
    [[ -z "$(pid_on_port "$port")" ]] || { kill -9 "$existing" 2>/dev/null || true; sleep 0.5; }
  else
    echo "→ 端口 $port 当前没有 server，直接起。"
  fi
  _serve "$root" "$port"
}

cmd_rm() {
  local slug="" force=""
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      *) slug="$a" ;;
    esac
  done
  [[ -n "$slug" ]] || die "用法: wt.sh rm <slug> [--force]"
  local root="$WT_DIR/$slug"
  [[ -d "$root" ]] || die "worktree 不存在: $slug"

  # 先停掉它的 server
  local port; port="$(port_of "$root")"
  if [[ -n "$port" ]]; then
    local p; p="$(pid_on_port "$port")"
    if [[ -n "$p" ]]; then echo "→ 停掉端口 $port 上的 server (pid $p)…"; kill "$p" 2>/dev/null || true; fi
  fi

  # 干净度检查
  local dirty=""
  ( cd "$root" && git diff --quiet && git diff --cached --quiet ) || dirty="工作区有未提交改动"
  local branch; branch="$(cd "$root" && git rev-parse --abbrev-ref HEAD)"
  local unmerged; unmerged="$(cd "$MAIN_ROOT" && git log --oneline origin/main.."$branch" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$unmerged" != "0" ]]; then
    dirty="${dirty:+${dirty}；}分支 ${branch} 有 ${unmerged} 个提交未合并到 origin/main"
  fi

  if [[ -n "$dirty" && -z "$force" ]]; then
    die "拒绝移除：${dirty}。确认要丢弃请加 --force"
  fi

  # 干净度已自查(无 tracked 改动 / 无未合并提交);用 --force 越过 git 对 untracked
  # 运行产物(.commander-port / dist / node_modules,均 gitignore)的阻拦。
  echo "→ git worktree remove --force .worktrees/$slug"
  ( cd "$MAIN_ROOT" && git worktree remove --force "$root" )
  echo "✓ 已移除 worktree ${slug}（分支 ${branch} 仍保留，需要可 git branch -D ${branch}）"
}

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  new)     shift; cmd_new "$@" ;;
  list|ls) shift; cmd_list "$@" ;;
  serve)   shift; cmd_serve "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  rm)      shift; cmd_rm "$@" ;;
  ""|-h|--help|help) usage ;;
  *) die "未知子命令: $1（看 wt.sh --help）" ;;
esac
