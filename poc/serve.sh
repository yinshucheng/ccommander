#!/bin/bash
# Skill UI POC - serve vibeflow dashboard
# Usage: ./serve.sh
# 启动一个 localhost server 然后打开浏览器

PORT=3721
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Serving Vibeflow Dashboard at http://localhost:$PORT"
echo "Press Ctrl+C to stop"
echo ""

# Open browser after a short delay
(sleep 1 && open "http://localhost:$PORT") &

# Serve
cd "$DIR" && python3 -m http.server $PORT
