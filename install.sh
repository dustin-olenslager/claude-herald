#!/usr/bin/env bash
# herald interactive installer.
# Run from a fresh clone:  ./install.sh
# Idempotent: re-running detects existing state and offers to reconfigure.

set -euo pipefail

# ── Colors (no-op if NO_COLOR set) ────────────────────────────────
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  C_B=$'\033[1m'; C_DIM=$'\033[2m'; C_R=$'\033[0m'
  C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_INFO=$'\033[1;36m'
else
  C_B=""; C_DIM=""; C_R=""; C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""
fi

say()  { printf "%s\n" "$*"; }
ok()   { printf "${C_OK}✓${C_R} %s\n" "$*"; }
warn() { printf "${C_WARN}!${C_R} %s\n" "$*"; }
err()  { printf "${C_ERR}✗${C_R} %s\n" "$*" >&2; }
ask()  { printf "${C_INFO}?${C_R} %s " "$*"; }
hdr()  { printf "\n${C_B}── %s ──${C_R}\n" "$*"; }

# ── 0. Prereqs ────────────────────────────────────────────────────
hdr "Prereqs"

if ! command -v docker >/dev/null 2>&1; then
  err "docker not installed. Install: https://docs.docker.com/engine/install/"
  exit 1
fi
ok "docker present ($(docker --version | awk '{print $3}' | tr -d ,))"

if ! docker compose version >/dev/null 2>&1; then
  err "docker compose plugin missing. Install: https://docs.docker.com/compose/install/"
  exit 1
fi
ok "docker compose present"

if [ ! -f docker-compose.yml ] || [ ! -d src ]; then
  err "Run this from the herald repo root (where docker-compose.yml lives)."
  exit 1
fi
ok "herald repo detected"

# ── 1. .env ───────────────────────────────────────────────────────
hdr "Config (.env)"

REUSE_ENV="n"
if [ -f .env ]; then
  warn "Existing .env found."
  ask "Reuse it? [Y/n]"
  read -r r; r="${r,,}"
  if [ -z "$r" ] || [ "$r" = "y" ] || [ "$r" = "yes" ]; then
    REUSE_ENV="y"
  fi
fi

if [ "$REUSE_ENV" = "y" ]; then
  ok "Reusing existing .env"
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
else
  cp -n .env.example .env || true

  while true; do
    say ""
    say "${C_DIM}Get a token: open https://t.me/BotFather → /newbot → name it → copy token${C_R}"
    ask "BotFather BOT_TOKEN:"
    read -r BOT_TOKEN
    if [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then break; fi
    err "Doesn't look like a Telegram token. Format: 123456:ABC-DEF..."
  done

  while true; do
    ask "Your Telegram @username (no @, just letters/digits/_):"
    read -r ALLOWED_USERNAME
    ALLOWED_USERNAME="${ALLOWED_USERNAME#@}"
    if [[ "$ALLOWED_USERNAME" =~ ^[A-Za-z0-9_]{3,32}$ ]]; then break; fi
    err "Invalid username."
  done

  say ""
  say "${C_DIM}Default mode controls how much CC can run without asking.${C_R}"
  say "${C_DIM}  strict — approve every edit + risky bash${C_R}"
  say "${C_DIM}  guided — auto edits, approve only risky bash (recommended)${C_R}"
  say "${C_DIM}  yolo   — approve nothing, full autonomy${C_R}"
  ask "DEFAULT_MODE [guided]:"
  read -r DEFAULT_MODE
  DEFAULT_MODE="${DEFAULT_MODE:-guided}"
  case "$DEFAULT_MODE" in strict|guided|yolo) ;; *) DEFAULT_MODE=guided;; esac

  # Write .env
  {
    echo "BOT_TOKEN=$BOT_TOKEN"
    echo "ALLOWED_USERNAME=$ALLOWED_USERNAME"
    echo "TARGET_CONTAINER=${TARGET_CONTAINER:-claude-code-rc}"
    echo "TARGET_USER=${TARGET_USER:-cc}"
    echo "TARGET_WORKDIR=${TARGET_WORKDIR:-/workspace}"
    echo "DEFAULT_MODEL=${DEFAULT_MODEL:-sonnet}"
    echo "DEFAULT_MODE=$DEFAULT_MODE"
    echo "APPROVAL_TIMEOUT_SECONDS=${APPROVAL_TIMEOUT_SECONDS:-300}"
    echo "CLAUDE_TIMEOUT_MS=${CLAUDE_TIMEOUT_MS:-600000}"
    echo "APPROVAL_PORT=${APPROVAL_PORT:-7788}"
    echo "STATE_FILE=${STATE_FILE:-/data/state.json}"
  } > .env
  chmod 600 .env
  ok ".env written"
  set -a; . ./.env; set +a
fi

# ── 2. Target container ───────────────────────────────────────────
hdr "Target container"

TARGET="${TARGET_CONTAINER:-claude-code-rc}"

if docker inspect "$TARGET" >/dev/null 2>&1; then
  ok "Existing container '$TARGET' found"
else
  warn "Container '$TARGET' does not exist."
  ask "Build a fresh one from examples/claude-container.Dockerfile? [Y/n]"
  read -r r; r="${r,,}"
  if [ -z "$r" ] || [ "$r" = "y" ] || [ "$r" = "yes" ]; then
    docker build -t herald-target:local -f examples/claude-container.Dockerfile examples/ >/dev/null
    docker run -d --name "$TARGET" --restart unless-stopped \
      -v "$(pwd)/workspace:/workspace" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      herald-target:local
    ok "Built and started '$TARGET'"
    warn "You must authenticate claude once before using the bot:"
    say "  docker exec -it -u cc $TARGET claude"
    say "  (follow the device-flow link; token persists in ~/.claude)"
  else
    err "Create your container manually, then re-run install.sh."
    exit 1
  fi
fi

# Check required tools inside target
say ""
say "${C_DIM}Checking target container for required tools…${C_R}"
MISSING=()
for tool in claude curl jq tmux; do
  if ! docker exec -u "${TARGET_USER:-cc}" "$TARGET" sh -c "command -v $tool >/dev/null 2>&1"; then
    MISSING+=("$tool")
  fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  warn "Missing in '$TARGET': ${MISSING[*]}"
  say "  ${C_DIM}— claude: \`npm install -g @anthropic-ai/claude-code\`${C_R}"
  say "  ${C_DIM}— curl/jq/tmux: \`apt-get install -y curl jq tmux\` (or equivalent)${C_R}"
  say "  ${C_DIM}tmux is required only if you want Telegram notifications for interactive sessions.${C_R}"
  say "  ${C_DIM}gh CLI is optional (only needed for /pr commands).${C_R}"
fi

# ── 3. Network ────────────────────────────────────────────────────
hdr "Network"

if docker network inspect herald-net >/dev/null 2>&1; then
  ok "Network 'herald-net' exists"
else
  docker network create herald-net >/dev/null
  ok "Created network 'herald-net'"
fi

if docker inspect "$TARGET" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | grep -q herald-net; then
  ok "'$TARGET' already on herald-net"
else
  docker network connect herald-net "$TARGET"
  ok "Connected '$TARGET' to herald-net"
fi

# ── 4. Build + start ──────────────────────────────────────────────
hdr "Build + start"

docker compose up -d --build 2>&1 | tail -3
sleep 2
if docker ps --format '{{.Names}}' | grep -q '^herald$'; then
  ok "herald running"
else
  err "herald failed to start. Logs:"
  docker logs herald --tail 30
  exit 1
fi

# ── 5. Final ──────────────────────────────────────────────────────
hdr "Done"

BOT_NAME=$(curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null | \
  sed -nE 's/.*"username":"([^"]+)".*/\1/p' || true)

if [ -n "$BOT_NAME" ]; then
  ok "Open https://t.me/${BOT_NAME} and send /start"
else
  ok "Open Telegram → find your bot → send /start"
fi
say ""
say "${C_DIM}Logs:  docker logs -f herald${C_R}"
say "${C_DIM}Stop:  docker compose down${C_R}"
say "${C_DIM}Mode:  /settings in Telegram${C_R}"
