# Herald

<p>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-ready-d97757">
  <img alt="Telegram" src="https://img.shields.io/badge/Telegram-bot-229ED9?logo=telegram&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/deploy-docker%20compose-2496ED?logo=docker&logoColor=white">
  <img alt="self-hosted" src="https://img.shields.io/badge/self--hosted-no%20SaaS-22c55e">
</p>

**Drive Claude Code from your phone via Telegram.** Send a message → it runs in your
own Claude Code container → you get a short summary back with a 📖 **Details** button.
Approve risky shell commands with a single tap. Review and merge PRs from your couch.

```
You 📱  "fix the failing auth test and open a PR"
Herald  ✅ Done — 1 file changed, tests green.  [📖 Details] [➡️ Continue] [⚙️ Settings]
You 📱  /pr 124  →  [Review] [Approve] [Merge] [Open]
```

## Why

Claude Code is amazing at the keyboard. But the moments you most want an AI dev —
standing in line, walking the dog, lying in bed at 11pm thinking about that one bug —
you don't have a keyboard. Herald fixes that: your dev environment, in your pocket, with
the approval guardrails you choose.

## Highlights

- 📱 **Telegram-native UI** — inline buttons, command autocomplete, screen-sized summaries.
- ⚖️ **Three approval modes** — 🔒 Strict / ⚖️ Guided / 🚀 Yolo. Risky shell gated to a single tap.
- 🔀 **PR from your couch** — `/pr 123` → view, approve, merge with buttons.
- ⛔ **Real `/stop`** — kills the running Claude process instantly. No 10-minute wrong turns.
- 🔌 **Self-host friendly** — one `docker compose up`. No SaaS, no proxy, your tokens stay yours.
- 🪝 **Bridges live terminal sessions too** — wrap `claude` in tmux and get pinged when it pauses for input.

## Quickstart (2 minutes)

```bash
git clone https://github.com/dustin-olenslager/claude-herald.git herald
cd herald
./install.sh
```

The installer:

1. Checks prereqs (docker, docker compose)
2. Prompts you for a `BOT_TOKEN` (links you to [@BotFather](https://t.me/BotFather))
3. Prompts for your Telegram `@username`
4. Lets you pick a default mode (strict/guided/yolo)
5. Detects your existing Claude container or builds a fresh one from [examples/claude-container.Dockerfile](./examples/claude-container.Dockerfile)
6. Creates the docker network, wires it up
7. Builds + starts herald
8. Prints your bot's `t.me/...` URL

If the installer builds a fresh Claude container, you'll need to authenticate `claude` once:
```bash
docker exec -it -u cc claude-code-rc claude
# follow the device-flow link in a browser; token persists
```

Then open the printed Telegram link, send `/start`. You're driving.

### Manual setup (if you don't want the installer)

<details>
<summary>Click to expand</summary>

```bash
git clone https://github.com/dustin-olenslager/claude-herald.git herald
cd herald
cp .env.example .env
# edit .env: BOT_TOKEN, ALLOWED_USERNAME, TARGET_CONTAINER

# create network, connect your existing claude container
docker network create herald-net
docker network connect herald-net <your-claude-container-name>

docker compose up -d --build
```

Target container requirements:
- `claude` CLI on PATH (`npm install -g @anthropic-ai/claude-code`)
- `bash`, `curl`, `jq` (for the approval hook)
- `gh` CLI (optional — needed for `/pr` commands)
- A logged-in `claude` (run `claude` once for device-flow auth, or set `ANTHROPIC_API_KEY`)
- Connected to the `herald-net` docker network

</details>

## Approval modes — what each does

| Tool call | 🔒 Strict | ⚖️ Guided | 🚀 Yolo |
|---|---|---|---|
| Read, Grep, Glob | auto | auto | auto |
| Edit, Write | **tap** | auto | auto |
| Bash (safe: ls, git status, npm test, etc.) | auto | auto | auto |
| Bash (risky: git push, rm -rf, deploy, docker down, etc.) | **tap** | **tap** | auto |
| Bash (very dangerous: curl \| bash, > /etc/foo, sudo) | **tap** | **tap** | auto |

Switch anytime with `/settings`. Default = ⚖️ Guided.

### What counts as "risky"?

The [hook script](./hooks/pretooluse-gate.sh) gates these Bash patterns:
- `rm -rf` / `rm -fr`
- `git push`, `git reset --hard`, `git clean -f`, `git checkout -- .`
- `docker compose down`, `docker rm/kill/stop/prune`
- `npm/pnpm/yarn/cargo publish`
- Scripts named `deploy*` / `release*`
- `psql ... DROP/DELETE/TRUNCATE`
- `sudo ...`

Strict mode also gates:
- Any redirect (`>`, `>>`) to a file
- `curl ... | bash` / `... | sh`
- All Edit / Write / MultiEdit tools

## Commands

| Command | Does |
|---|---|
| `/settings` | Mode + model picker (inline buttons) |
| `/pr <num>` | View PR, get [Review][Approve][Merge][Open] buttons |
| `/prs` | List your open PRs, one tap to view each |
| `/repo <path>` | Switch the working directory (per-chat) |
| `/new` | Start a fresh Claude session (drops context) |
| `/continue` | Send "continue" to current session |
| `/stop` | Kill the running task |
| `/status` | Show mode, model, repo, session state |
| `/help` | Help message |
| `/ping` | Liveness check |

Buttons under every reply: 📖 Details · ➡️ Continue · 🛑 Stop · 🆕 New · ⚙️ Settings — only the relevant ones show at any given time.

## Architecture

```
        Telegram ─── BOT_TOKEN ───┐
                                  │
                            ┌─────▼─────┐
                            │  herald   │  (this repo)
                            │  Node 22  │
                            │           │ ◄── POST /approve ─── hook
                            └─────┬─────┘                       │
                                  │                             │
                       docker exec│                             │
                                  ▼                             │
                       ┌─────────────────────┐                  │
                       │  target container   │                  │
                       │  ─ claude CLI       │                  │
                       │  ─ pretooluse-gate.sh ◄────────────────┘
                       │  ─ your repo @ /workspace                
                       └─────────────────────┘
```

- Bot polls Telegram (long-poll, no public webhook needed).
- Bot `docker exec`s into target container with `claude -p`.
- Target container has the hook script mounted; runs on every tool call.
- Hook posts to bot's internal HTTP server. Bot sends inline approval buttons.
- You tap → bot resolves → hook exits 0 → tool runs.

## Works with Phalanx (autonomous loop from your phone)

Herald is the **reference adapter** for [Phalanx](https://github.com/dustin-olenslager/claude-phalanx) —
an always-on, hook-enforced pipeline + **no-babysit supervisor** for Claude Code. Send a
request that won't finish in one session and Herald hands it to Phalanx's detached
supervisor, which relaunches fresh `claude -p "/work"` passes until the backlog is green
or `BLOCKED` — no human ever runs `/clear`.

- Herald exposes `POST /event`, which implements Phalanx's notify **port**. When it
  launches the supervisor it sets `PHALANX_NOTIFY_URL=<herald>/event`, so the loop's
  `start`/`progress`/`done`/`blocked` events stream into your Telegram topic.
- Unfinished inline runs **auto-escalate** to the supervisor by default
  (`PHALANX_AUTOESCALATE=0` to disable).
- Phalanx is **optional** — Herald drives a plain `claude -p` run just fine without it.
  Install Phalanx in the target container to upgrade one-shot replies into a
  self-continuing loop you can watch from your couch.

## Interactive sessions (Telegram-as-input-bridge)

The default flow above is **bot-initiated**: you type in Telegram, the bot spawns a `claude -p` run, you get a reply.

There's a second flow for the case where you **already have Claude open in a terminal** (in tmux on your server) and you walk away. When Claude pauses for input — a permission prompt, an idle wait, anything — the bot pings you on Telegram and lets you respond. Your tap/typing is injected straight into the live tmux pane.

### Setup (one time)

1. Make sure `tmux` is installed inside your target container:
   ```bash
   docker exec -u root claude-code-rc apt-get install -y tmux
   ```
   (`install.sh` will warn you if it's missing.)

2. Add this to `~/.claude/settings.json` inside the target container (path: `/home/<TARGET_USER>/.claude/settings.json` or wherever your `claude` user's settings live):
   ```json
   {
     "hooks": {
       "Notification": [
         { "hooks": [{ "type": "command", "command": "/usr/local/bin/herald-notify-tg.sh" }] }
       ]
     }
   }
   ```
   The hook script and the launcher are installed automatically by herald on startup (`docker cp` into the target container).

### Usage

Launch Claude through the supplied tmux wrapper instead of running `claude` directly:

```bash
herald-tmux            # session name: cc-main
herald-tmux feature-x  # session name: feature-x
```

The wrapper sets `CC_TMUX_TARGET` / `CC_TMUX_CONTAINER` env vars so the Notification hook knows where to send keystrokes back. If you skip the wrapper (i.e. just run `claude`), the hook silently no-ops — interactive Telegram notifications won't fire, but nothing breaks.

### What you get in Telegram

When Claude waits for you, you get:

```
🔔 Claude needs you
· /workspace/your-repo

<the message Claude is showing — typically a permission prompt or "waiting for input">
```

…with these buttons:

| Button | Sends to tmux |
|---|---|
| `1` / `2` / `3` | the digit + Enter (covers permission menu choices) |
| `✏️ Reply` | bot waits for your next Telegram message, then sends it + Enter |
| `⛔ Esc` | sends the Escape key (cancel a Claude prompt) |

Tokens expire after `NOTIFY_TTL_SECONDS` (default: 1h) — taps on stale messages show "(expired)".

### Security note for interactive flow

The buttons execute `docker exec <container> tmux send-keys` against your live session. Anyone who can reach `herald:7788/notify` from inside your docker network can trigger a notify (no auth on the hook endpoint). The Telegram button → send-keys step is gated by your `ALLOWED_USERNAME` / `ALLOWED_USER_ID`, so a leaked notify token alone can't inject text. Threat model is the same as the rest of herald: trusted infra, untrusted humans on the internet.

## Security

**The approval gate protects against accidents, not a malicious LLM.** If a model decides to bypass the gate via `curl bot:7788/approve` itself, it can — they share the docker network. Threat model is "trusted Claude on personal infra," not "untrusted code in a public sandbox."

If you need hard isolation:
- Run the target container with read-only mounts where possible
- Don't grant docker.sock to the target unless you need it
- Use 🔒 Strict mode
- Or run herald only in non-production environments

## Configuration

All via `.env`:

| Var | Default | What |
|---|---|---|
| `BOT_TOKEN` | — | BotFather token (required) |
| `ALLOWED_USERNAME` | — | Your Telegram @username (required, or use `ALLOWED_USER_ID`) |
| `ALLOWED_USER_ID` | — | Numeric Telegram user ID (alt) |
| `TARGET_CONTAINER` | `claude-code-rc` | Docker container running `claude` |
| `TARGET_USER` | `cc` | User inside target container |
| `TARGET_WORKDIR` | `/workspace` | Default cwd for `claude` |
| `DEFAULT_MODEL` | `sonnet` | Default Claude model |
| `DEFAULT_MODE` | `guided` | strict \| guided \| yolo |
| `APPROVAL_TIMEOUT_SECONDS` | `300` | Approval prompt timeout |
| `CLAUDE_TIMEOUT_MS` | `600000` | Max time for one Claude turn |
| `APPROVAL_PORT` | `7788` | Internal HTTP port |
| `NOTIFY_TTL_SECONDS` | `3600` | How long a pending notify token stays valid |

## Roadmap (v0.2+)

- GitHub webhook receiver — push notifications for PR opened, CI failed, review requested
- Voice memo input (Whisper → prompt)
- Image upload → forwarded to Claude with vision
- Per-repo preset buttons (Tests, Build, Deploy)
- Cost caps + daily spend summary
- Multi-user (per-user sessions, optional OAuth)
- MCP-based permission tool (proper Claude Code integration vs hook)

## Contributing

PRs welcome. Keep it focused — this is meant to stay a small, self-host-friendly tool, not a SaaS.

## License

MIT — see [LICENSE](./LICENSE).

## Author

Built by [Dustin Olenslager](https://github.com/dustin-olenslager) on a Telegram chat with Claude Code.
