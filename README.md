# cc-bot

**Drive Claude Code from your phone via Telegram.** PR-friendly. Strict / Guided / Yolo approval modes.

Send a message → it runs in your Claude Code container. Get a short summary back with a 📖 Details button. Approve risky shell commands with a single tap. Review and merge PRs from your couch.

## Why

Claude Code is amazing at the keyboard. But the moments you most want an AI dev — standing in line, walking the dog, lying in bed at 11pm thinking about that one bug — you don't have a keyboard. cc-bot fixes that.

## Features (v0.1)

- **Telegram-native UI.** Inline buttons, command autocomplete, summaries that fit your screen.
- **Three approval modes:** 🔒 Strict (every edit) / ⚖️ Guided (only risky bash) / 🚀 Yolo (full autonomy). Switch in `/settings`.
- **PR commands.** `/pr 123` to view, then tap to approve / merge. `/prs` for your open PRs.
- **Real `/stop`.** Kills the running Claude process. No more waiting 10 minutes for a wrong turn.
- **Summaries by default.** Claude is instructed to TL;DR every reply; full response sits behind a 📖 Details button.
- **Self-host friendly.** One `docker compose up`. No SaaS, no proxy, your tokens stay yours.

## Quickstart (2 minutes)

```bash
git clone https://github.com/dustin-olenslager/cc-bot.git
cd cc-bot
./install.sh
```

The installer:

1. Checks prereqs (docker, docker compose)
2. Prompts you for a `BOT_TOKEN` (links you to [@BotFather](https://t.me/BotFather))
3. Prompts for your Telegram `@username`
4. Lets you pick a default mode (strict/guided/yolo)
5. Detects your existing Claude container or builds a fresh one from [examples/claude-container.Dockerfile](./examples/claude-container.Dockerfile)
6. Creates the docker network, wires it up
7. Builds + starts cc-bot
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
git clone https://github.com/dustin-olenslager/cc-bot.git
cd cc-bot
cp .env.example .env
# edit .env: BOT_TOKEN, ALLOWED_USERNAME, TARGET_CONTAINER

# create network, connect your existing claude container
docker network create cc-bot-net
docker network connect cc-bot-net <your-claude-container-name>

docker compose up -d --build
```

Target container requirements:
- `claude` CLI on PATH (`npm install -g @anthropic-ai/claude-code`)
- `bash`, `curl`, `jq` (for the approval hook)
- `gh` CLI (optional — needed for `/pr` commands)
- A logged-in `claude` (run `claude` once for device-flow auth, or set `ANTHROPIC_API_KEY`)
- Connected to the `cc-bot-net` docker network

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
                            │  cc-bot   │  (this repo)
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

## Security

**The approval gate protects against accidents, not a malicious LLM.** If a model decides to bypass the gate via `curl bot:7788/approve` itself, it can — they share the docker network. Threat model is "trusted Claude on personal infra," not "untrusted code in a public sandbox."

If you need hard isolation:
- Run the target container with read-only mounts where possible
- Don't grant docker.sock to the target unless you need it
- Use 🔒 Strict mode
- Or run cc-bot only in non-production environments

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
