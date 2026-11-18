#!/bin/sh
# Codex MCP 启动器：解析 node，然后 exec 真正的 server。
# 为什么不用 "command": "node"：打包后的 Codex 进程 PATH 里未必有 node，
# 而 CODEX_MCP_NODE_PATH 是 Codex 自己注入的可靠路径。
set -e
DIR=$(cd "$(dirname "$0")" && pwd)

NODE="${CODEX_MCP_NODE_PATH:-}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  for c in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  NODE=$(command -v node || true)
fi
if [ -z "$NODE" ]; then
  echo "codex-wallpaper-engine: 找不到 node，无法启动 MCP server" >&2
  exit 127
fi

exec "$NODE" "$DIR/server.mjs" "$@"
