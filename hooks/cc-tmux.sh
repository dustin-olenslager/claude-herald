#!/usr/bin/env bash
# Launch (or attach to) an interactive Claude Code session inside tmux,
# exposing the tmux target to the cc-bot Notification hook so the bot can
# inject keystrokes from Telegram.
#
# Usage:
#   cc-tmux.sh                       # session name: cc-main
#   cc-tmux.sh feature-x             # session name: feature-x
#
# Env (auto-detected; override as needed):
#   CC_TMUX_CONTAINER  Container hosting this tmux session (default: $(hostname))
#   CC_BOT_URL         cc-bot HTTP base (default: http://cc-bot:7788)

set -euo pipefail

SESSION="${1:-cc-main}"
CONTAINER="${CC_TMUX_CONTAINER:-$(hostname)}"
BOT_URL="${CC_BOT_URL:-http://cc-bot:7788}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not installed in this container. Install it (e.g. apt-get install -y tmux) and retry." >&2
  exit 1
fi
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "claude CLI not on PATH." >&2
  exit 1
fi

TARGET="${SESSION}:0.0"

# new-session -A: attach if exists, else create with the given command.
exec tmux new-session -A -s "$SESSION" \
  env \
    CC_TMUX_TARGET="$TARGET" \
    CC_TMUX_CONTAINER="$CONTAINER" \
    CC_BOT_URL="$BOT_URL" \
    "$CLAUDE_BIN"
