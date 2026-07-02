#!/bin/bash
# Commander PreToolUse clarify hook.
# 终端 / 网页 spawn 的 claude 调 AskUserQuestion 或 ExitPlanMode 时被触发。
# 行为：把 stdin 原样转发给 commander 的 /api/clarify-wait（长轮询 ≤30 min）→
#       commander 在网页 PermissionCard 收到用户决定后返回 hookSpecificOutput JSON
#       → 本脚本把 JSON 原样输出到 stdout，claude 据此放行/拒绝/改写入参。
#
# 协议：https://code.claude.com/docs/en/hooks（PreToolUse 段）
# commander 端点：见 src/server/index.js POST /api/clarify-wait
#
# 失败兜底（commander 没起 / 网络问题 / 解析失败）：输出 {"continue":true}，让
# claude 继续走默认流程（终端会按原生方式提问用户）—— 不能因为 commander 挂了
# 就阻塞用户的终端 claude。
#
# 超时：curl --max-time 1830（commander 那边 30 min 长轮询 + 30s buffer）；
# claude hook 默认 PreToolUse 600s — 我们在 settings.json 里把 timeout 调到 1800。

set -uo pipefail   # 不 set -e：失败要走兜底，不能直接退

PORT="${COMMANDER_PORT:-3890}"
URL="http://127.0.0.1:${PORT}/api/clarify-wait"

# 读 stdin（claude hook 把事件 JSON 从 stdin 传入）
input="$(cat)"

# 转发；失败 / 非 200 / 空响应都走兜底
resp="$(printf '%s' "$input" \
  | curl -sS --max-time 1830 \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      "$URL" 2>/dev/null)" || resp=""

# 校验是个合法 JSON 对象再输出（防止 commander 半截响应误导 claude）
if [ -n "$resp" ] && command -v python3 >/dev/null 2>&1; then
  validated="$(printf '%s' "$resp" | python3 -c '
import sys, json
try:
  obj = json.loads(sys.stdin.read())
  assert isinstance(obj, dict)
  print(json.dumps(obj))
except Exception:
  sys.exit(1)
' 2>/dev/null)"
  if [ -n "$validated" ]; then
    printf '%s\n' "$validated"
    exit 0
  fi
fi

# 兜底：放行，让 claude 走默认行为
printf '{"continue":true}\n'
exit 0
