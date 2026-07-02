#!/usr/bin/env bash
# herald PreToolUse hook
# Reads tool-call JSON from stdin; asks herald for approval if risky.
# Exit 0 = allow, exit 2 = block (claude sees stderr as denial reason).

set -euo pipefail

BOT_URL="${HERALD_URL:-http://herald:7788}"
CHAT_ID="${HERALD_CHAT_ID:-}"
THREAD="${HERALD_THREAD_ID:-}"
MODE="${HERALD_MODE:-guided}"

# Read full stdin (the PreToolUse JSON payload)
PAYLOAD=$(cat)

# Quick exits ---------------------------------------------------------------

# yolo: nothing is gated
if [ "$MODE" = "yolo" ]; then exit 0; fi

# no chat id: we can't ask anyone — fail open (don't block legitimate non-bot use)
if [ -z "$CHAT_ID" ]; then exit 0; fi

# Parse JSON (use jq if available, fallback to crude grep)
if command -v jq >/dev/null 2>&1; then
  TOOL=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty')
  CMD=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty')
  CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty')
  SESSION=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty')
else
  TOOL=$(printf '%s' "$PAYLOAD" | grep -oE '"tool_name":[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  CMD=$(printf '%s' "$PAYLOAD" | grep -oE '"command":[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  CWD=""
  SESSION=""
fi

# Headless git-write allowlist ---------------------------------------------
# In a headless bot run (HOME=/home/cc) or a Phalanx one-shot (PHALANX_ONESHOT=1)
# nobody can tap an approval keyboard, so a gated git write (push/tag/merge/
# checkout) hangs until the approval timeout and then fails closed. Those four
# are always safe on a task branch, so auto-approve them ONLY when headless —
# still logged, and herald stays fully on for everything else and for
# interactive sessions.
if [ "${HOME:-}" = "/home/cc" ] || [ "${PHALANX_ONESHOT:-}" = "1" ]; then
  if [ "$TOOL" = "Bash" ] && \
     printf '%s' "$CMD" | grep -qE '(^|[[:space:]]|;|&&|\|\|)git[[:space:]]+(push|tag|merge|checkout)([[:space:]]|$)'; then
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')
    printf '%s headless-allow %s: %s\n' "$TS" "$TOOL" "$CMD" \
      >> "${HERALD_GATE_LOG:-/tmp/herald-gate.log}" 2>/dev/null || true
    exit 0
  fi
fi

# Decide if this tool call needs approval ----------------------------------

needs_approval=0

case "$TOOL" in
  Bash)
    # Risky patterns gated in BOTH strict and guided
    if printf '%s' "$CMD" | grep -qE '(^|[[:space:]])(rm[[:space:]]+-[rfRF]+|rm[[:space:]]+--recursive|rm[[:space:]]+--force)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+push'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+clean[[:space:]]+-[fF]'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+checkout[[:space:]]+--'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'docker[[:space:]]+(compose[[:space:]]+)?(down|rm|kill|stop|prune)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE '(npm|pnpm|yarn|cargo)[[:space:]]+publish'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE '(^|[[:space:]])(deploy|release)([[:space:]]|$|\.sh)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qiE 'psql.*(DROP|DELETE|TRUNCATE)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'sudo[[:space:]]'; then needs_approval=1; fi
    # Code-execution / obfuscation vectors gated in BOTH strict and guided.
    if printf '%s' "$CMD" | grep -qE '(^|[[:space:]])eval([[:space:]]|$)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE '(bash|sh)[[:space:]]+-c([[:space:]]|$)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'curl[[:space:]].*\|[[:space:]]*(bash|sh)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE '(^|[[:space:]])base64([[:space:]]|$)'; then needs_approval=1; fi
    if printf '%s' "$CMD" | grep -qE 'python[0-9.]*[[:space:]]+-c([[:space:]]|$)'; then needs_approval=1; fi
    # strict: ALSO any write redirection or curl|bash
    if [ "$MODE" = "strict" ]; then
      if printf '%s' "$CMD" | grep -qE '(>|>>)[[:space:]]*[^|]'; then needs_approval=1; fi
      if printf '%s' "$CMD" | grep -qE 'curl[[:space:]].*\|[[:space:]]*(bash|sh)'; then needs_approval=1; fi
    fi
    ;;
  Edit|Write|MultiEdit|NotebookEdit)
    if [ "$MODE" = "strict" ]; then needs_approval=1; fi
    ;;
esac

if [ "$needs_approval" -eq 0 ]; then exit 0; fi

# Ask the bot --------------------------------------------------------------

REQ_JSON=$(printf '{"chatId":%s,"sessionId":"%s","toolName":"%s","command":%s,"cwd":"%s","mode":"%s","thread":%s}' \
  "$CHAT_ID" \
  "$SESSION" \
  "$TOOL" \
  "$(printf '%s' "$CMD" | jq -Rs . 2>/dev/null || printf '"%s"' "$(printf '%s' "$CMD" | sed 's/"/\\"/g')")" \
  "$CWD" \
  "$MODE" \
  "${THREAD:-null}")

HTTP_CODE=$(curl -sS -o /tmp/herald-approval-resp.$$ -w "%{http_code}" \
  --max-time "$((${APPROVAL_TIMEOUT_SECONDS:-300} + 10))" \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "x-herald-secret: ${HERALD_HOOK_SECRET:-}" \
  -d "$REQ_JSON" \
  "$BOT_URL/approve" 2>/dev/null || echo "000")

REASON=$(cat /tmp/herald-approval-resp.$$ 2>/dev/null || true)
rm -f /tmp/herald-approval-resp.$$

case "$HTTP_CODE" in
  200)
    exit 0
    ;;
  403)
    echo "Denied by user via herald. Reason: ${REASON:-no reason given}" >&2
    exit 2
    ;;
  *)
    echo "herald approval failed (HTTP $HTTP_CODE). Bot unreachable at $BOT_URL — blocking to be safe. Set HERALD_MODE=yolo to bypass." >&2
    exit 2
    ;;
esac
