#!/usr/bin/env bash
# 复测 claude CLI 的斜杠命令在 stream-json 模式下哪些能用。
# 用于扩 src/client/TaskCard.jsx 里 SLASH_COMMANDS 列表前的事实核对。
#
# 用法：./scripts/test-slash-commands.sh [/cmd1 /cmd2 ...]
# 不传参数时跑一份默认覆盖面较广的命令集合。

set -uo pipefail

if [ $# -gt 0 ]; then
  CMDS=("$@")
else
  CMDS=(
    /compact /usage /insights /review /security-review /code-review
    /simplify /init /debug /loop /context /memory /agents /permissions
    /model /resume /mcp /diff /doctor /plan /help /clear /effort
  )
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "✗ claude CLI 不在 PATH。" >&2
  exit 1
fi

echo "claude 版本: $(claude --version)"
echo "—— 探测开始 ——"
for cmd in "${CMDS[@]}"; do
  result=$(echo "$cmd" | claude -p --output-format stream-json --verbose 2>&1 \
    | grep -oE '"text":"[^"]{1,120}' | head -1 || echo "")
  if echo "$result" | grep -q "isn't available"; then
    echo "❌  $cmd  →  TTY-only（claude 拒绝）"
  elif [ -z "$result" ]; then
    echo "⚠   $cmd  →  空响应（可能有副作用但无回显，需手测）"
  else
    short=${result:0:80}
    echo "✅  $cmd  →  ${short}"
  fi
done
echo "—— 结束 ——"
echo "✅ 的命令可加入 SLASH_COMMANDS；⚠ 的需手动验证；❌ 的别加（用户输入只会得到拒绝信息）"
