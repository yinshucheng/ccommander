#!/bin/bash
# Commander hook emitter.
# 被 Claude Code hook 调用，把事件追加写入 ~/.commander/events.jsonl。
# 用法: commander-emit.sh <event_type>   (event_type: waiting|completed|running|closed)
#
# 复用 ~/.claude/scripts/parse-hook.py 提取字段（已有：SESSION_ID? 由 stdin JSON 取，
# PROJECT_NAME / PROJECT_ROOT / SESSION_NAME / CWD）。若 parse-hook.py 不存在则降级。

set -euo pipefail

EVENT_TYPE="${1:-running}"
COMMANDER_DIR="$HOME/.commander"
EVENTS_FILE="$COMMANDER_DIR/events.jsonl"
PARSER="$HOME/.claude/scripts/parse-hook.py"

mkdir -p "$COMMANDER_DIR"

# 读 stdin（Claude Code hook 把事件 JSON 从 stdin 传入）
input="$(cat)"

# 默认值
SID=""; PROJECT_NAME=""; PROJECT_ROOT=""; SESSION_NAME=""; CWD=""

# 先用内联 python 取 session_id / cwd（parse-hook.py 不打印 session_id）
if command -v python3 >/dev/null 2>&1; then
  read -r SID CWD <<EOF2
$(printf '%s' "$input" | python3 -c 'import sys,json
try:
  h=json.load(sys.stdin)
  print(h.get("session_id",""), h.get("cwd",""))
except Exception:
  print("","")' 2>/dev/null || echo " ")
EOF2
fi

# 复用现有 parse-hook.py 拿 PROJECT_NAME/PROJECT_ROOT/SESSION_NAME
if [ -f "$PARSER" ] && command -v python3 >/dev/null 2>&1; then
  tmpfile="$(mktemp)"
  printf '%s' "$input" > "$tmpfile"
  # parse-hook.py 输出形如 PROJECT_NAME="x" 的 shell 赋值
  eval "$(python3 "$PARSER" "$tmpfile" 2>/dev/null || true)"
  rm -f "$tmpfile"
fi

# git 分支（best effort）
BRANCH=""
if [ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT/.git" ]; then
  BRANCH="$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 用 python 安全拼 JSON（避免转义问题）
python3 -c '
import json, sys
ts, etype, sid, root, project, name, cwd, branch = sys.argv[1:9]
rec = {"ts": ts, "type": etype, "sid": sid, "root": root,
       "project": project, "name": name, "cwd": cwd}
if branch:
    rec["branch"] = branch
print(json.dumps(rec, ensure_ascii=False))
' "$TS" "$EVENT_TYPE" "${SID:-}" "${PROJECT_ROOT:-}" "${PROJECT_NAME:-}" "${SESSION_NAME:-}" "${CWD:-}" "${BRANCH:-}" \
  >> "$EVENTS_FILE" 2>/dev/null || true

exit 0
