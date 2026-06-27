#!/usr/bin/env bash
# herald Notification hook
# Fires when Claude Code is waiting for user input (idle, permission prompt, etc.)
# Posts to herald, which forwards to Telegram with buttons that send keystrokes
# back into the tmux-hosted interactive session.
#
# Inert in non-tmux sessions and in bot-spawned sessions (avoids notify loops).

set -euo pipefail

# Skip bot-spawned sessions: herald sets HERALD_CHAT_ID for its own claude -p runs.
if [ -n "${HERALD_CHAT_ID:-}" ]; then exit 0; fi

# Skip if not running in a tmux-tracked interactive session.
TARGET="${CC_TMUX_TARGET:-}"
if [ -z "$TARGET" ]; then exit 0; fi

CONTAINER="${CC_TMUX_CONTAINER:-}"
if [ -z "$CONTAINER" ]; then
  # Best-effort fallback: container's own hostname matches its name in most setups.
  CONTAINER="$(hostname)"
fi

BOT_URL="${HERALD_URL:-http://herald:7788}"

PAYLOAD="$(cat)"

if command -v jq >/dev/null 2>&1; then
  MSG=$(printf '%s' "$PAYLOAD" | jq -r '.message // empty')
  SESSION=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty')
  CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty')
else
  MSG=""
  SESSION=""
  CWD=""
fi

# chatId is resolved server-side from herald state (single-user setup).
REQ_JSON=$(jq -n \
  --arg message "$MSG" \
  --arg sessionId "$SESSION" \
  --arg container "$CONTAINER" \
  --arg tmuxTarget "$TARGET" \
  --arg cwd "$CWD" \
  '{message: $message, sessionId: $sessionId, container: $container, tmuxTarget: $tmuxTarget, cwd: $cwd}')

curl -sS -m 10 \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "x-herald-secret: ${HERALD_HOOK_SECRET:-}" \
  -d "$REQ_JSON" \
  "$BOT_URL/notify" >/dev/null 2>&1 || true

exit 0
