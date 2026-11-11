# UniQlaw

[![CI](https://github.com/hans00/uniqlaw/actions/workflows/ci.yml/badge.svg)](https://github.com/hans00/uniqlaw/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A multi-channel agent daemon. Each chat — a Telegram DM, a Discord channel, a Slack thread, a LINE group — gets its own long-lived agent session. The agent behind it can be **Claude Code, Codex, OpenCode, Antigravity, any ACP agent, or a plain LLM API** (OpenAI, Anthropic, Gemini, Bedrock, Vertex AI, Azure OpenAI, any OpenAI-compatible endpoint), chosen per profile and per channel.

Successor to [ClaudeClaw v2](https://github.com/hans00/claudeclaw2) (Claude-only, tmux-only). Everything is a plugin; features don't disappear when you switch provider.

> **Status: early (0.1).** Core features are covered by unit and contract tests and have been run end to end with real Claude Code sessions. Some adapters are less proven; see [Known gaps](#known-gaps). Expect breaking changes to settings before 1.0.

```
 Telegram ─┐                                              ┌─ claude-tmux / claude-sdk
 Discord  ─┤    ┌──────────────── UniQlaw daemon ───────┐ ├─ codex (app-server)
 Slack    ─┼──► │ router · per-session queue/steer      │─┼─ opencode (serve)
 LINE     ─┤    │ approvals · output routing by origin  │ ├─ acp (any ACP agent)
 Web / CLI─┘    │ cron · heartbeat · model routing      │ ├─ agy (Antigravity CLI)
                │ message bus ── MCP gateway ── A2A ────│─┤─ pi (LLM APIs, own harness)
                └───────────────────────────────────────┘ └─ remote A2A agents
```

## What you get

- **Per-chat sessions**: every DM is its own session (per user, per platform, like OpenClaw), and groups/channels/threads get their own too, queue / steer / interrupt handling for messages that arrive mid-turn, `/stop`, `/new`, `/status`, `/model`.
- **Switching profiles**: `/profile <name>` moves a chat to another profile (another agent or model) and `/profile reset` moves it back. The conversation follows: providers that share sessions (same provider, or Claude Code TUI ↔ SDK) keep the same session; otherwise the new profile gets the raw transcript, and a profile you return to resumes its own session plus what happened meanwhile. When a profile hits its usage limit, the owner is asked in chat whether to switch to one of its `fallback` profiles and the message is re-sent there; anyone else gets the error.
- **Group modes**: in `mention` mode (default) the bot answers only when @mentioned or replied to, and keeps the other messages (the last `historyLimit`) as context for its next turn; in `always` mode it reads every message and decides whether to answer (`NO_REPLY`), optionally skipping messages that @mention someone else. Set it in `groups` (per channel in `groups.channels`) or switch a group with `/activation mention|always|reset`. `allowFrom` limits who can wake the agent in a group (matched on the platform user id, never a name); `others: "context" | "ignore"` keeps or drops messages that don't wake it.
- **Per-channel capabilities**: `channels` gives each chat a set of tool groups (`chat`, `memory`, `web`, `files.read`, `files.write`, `bash`, `agents`, `cron`, `worker`, `xsession`, `notify`, `config`; `"*"` = all, `deny` subtracts). The session only gets those tools: the MCP gateway hides the rest and Claude Code is launched with matching `--tools` / `--disallowedTools`. Chats with no entry use `defaults`; with no `defaults`, chats keep every tool (so upgrading changes nothing). Cron jobs, workers and the heartbeat keep their own settings. ⚠ `bash`, `files.write`, `cron`, `worker` and `xsession` are admin-level: each one can reach an unrestricted session or UniQlaw's own config, so granting any of them grants effectively full access (the daemon warns at startup). Restricted chats can't read `.uniqlaw/` with Claude's file tools. See [`docs/architecture.md`](docs/architecture.md) §10.3.
- **Approvals on your phone**: permission prompts from any provider become buttons on the chat that triggered the work (or the operator).
- **A provider-independent message bus** exposed to every agent as MCP tools: `agents_list`, `agent_ask`, `agent_trigger`, `notify`, `send_file`, `task_status`, `worker_start`, `worker_stop`, `memory_write` / `memory_search` / `memory_get`, plus `cron_list` / `cron_save` / `cron_delete`. Provider-native cross-session features are disabled so nothing bypasses routing.
- **A2A v1.0**: expose profiles as A2A agents; remote A2A agents show up in `agents_list` and answer `agent_ask`.
- **Workers**: a session can start another coding agent (any profile: Claude Code, Codex, OpenCode, …) in a chosen directory on the same machine with `worker_start`, and get its report back. A human can take a worker over: `/attach <worker>` from a chat (any provider) or `uniqlaw attach <worker>` in a terminal (live for `claude-tmux`; `claude-sdk` / `codex` are handed to their own CLI and handed back on exit). Allowed directories and profiles come from `workers` in settings (default: the project directory only).
- **Memory and dreaming**: one long-term memory for the whole assistant, independent of the provider: `memory/MEMORY.md` (in every chat's prompt) plus daily notes the agents write with `memory_write` and search with `memory_search` (substring search, works for Chinese/Japanese). An optional nightly *dreaming* sweep, after OpenClaw's, promotes notes that keep coming up into `MEMORY.md`: rules pick the candidates, the model only decides add / merge / supersede / skip, and the text written is always the original note, so it can't invent memories; notes from group chats and background jobs are never promoted. It also keeps a dream diary (`memory/DREAMS.md`). Claude Code's own auto-memory is turned off so there is one memory, not two.
- **Voice messages**: by default the agent gets the audio file. Optionally a transcript is added for providers that can't take audio, with local whisper.cpp (`@fugood/whisper.node` + ffmpeg) or any OpenAI-compatible transcription API (OpenAI, Groq, a local server) — see [`docs/INSTALL.md`](docs/INSTALL.md) §4.
- **Scheduling**: v2-format cron jobs (IANA time zones, optional catch-up) and a heartbeat with quiet hours. By default each runs in its own internal session (`heartbeat`, `cron:<job>`). A job can pin a `profile` or switch the `model` for its turn, and can reach humans or other sessions through the bus (`notify`, `agent_trigger`, `agent_ask`), or set `replyTo: "none"` and decide for itself.
- **Model routing**: per-turn model choice by keywords/phrases with hysteresis (v2 "agentic modes").
- **Multiple instances per machine**: per-project lock, auto-assigned ports, per-instance tmux socket, bot-token claims so two instances never poll the same bot.
- **Web dashboard** on 127.0.0.1: sessions with live transcripts, jobs, logs.
- **Migration from ClaudeClaw v2**: an agent-readable guide ([`docs/MIGRATE.md`](docs/MIGRATE.md), `/uniqlaw:migrate` in Claude Code) instead of a fixed script.

## Providers

| provider | drives | streaming | mid-turn steer | approvals | model switch | notes |
|---|---|---|---|---|---|---|
| `claude-tmux` | real `claude` TUI in tmux | per segment | ✅ | ✅ (dialog detection) | live | full TUI ecosystem; tmux survives daemon restarts; denying a permission ends the turn (core continues it) |
| `claude-sdk` | Claude Agent SDK | per token | ✅ | ✅ | live | shares sessions with `claude-tmux` both ways |
| `codex` | `codex app-server` | per token | ✅ | ✅ | live (per turn) | Codex's own collaboration tools can't be removed but only see their own thread |
| `opencode` | `opencode serve` | per token | ✅ | ✅ | live (per message) | one server per session |
| `acp` | any ACP agent (default `opencode acp`) | per token | opt-in | ✅ | if the agent exposes it | one agent process per session by default |
| `agy` | Antigravity CLI headless | per token | ❌ (queued) | ❌ — pre-allowed commands only | respawn | login lives in the system keyring: all instances share one Google account |
| `pi` | pi-coding-agent SDK in-process | per token | ✅ | ✅ | live | OpenAI, Anthropic, Gemini, Bedrock, Vertex, Azure, OpenAI-compatible |

Missing capabilities are filled in by the core (e.g. turn-boundary queueing when a provider can't steer) or rejected at startup with a clear message — never silently degraded. Details: [`docs/architecture.md`](docs/architecture.md) §5–§6, §15.

## Platforms

Telegram (long-poll), Discord (Gateway), Slack (Socket Mode), LINE (webhook), plus the web dashboard / HTTP API. `allowedUserIds` is required on every platform — an empty list means **nobody** can talk to the bot (v2 allowed everyone). Someone not on the list who DMs the bot gets a pairing code; an operator approves it with `/pair approve <code>` in chat or `uniqlaw pairing approve <code>`, and that user is accepted from then on (stored in the state database, not as an operator). Turn this off with `"pairing": { "enabled": false }`.

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.3, plus the CLI of the provider you pick (`claude` + `tmux`, `codex`, `opencode`, `agy`; `pi` needs nothing extra).

```bash
git clone https://github.com/hans00/uniqlaw.git ~/Projects/uniqlaw && cd ~/Projects/uniqlaw
bun install
bun link                      # exposes `uniqlaw` on PATH (or use: bun packages/cli/src/main.ts)

cd ~/my-agent-project
uniqlaw init                  # wizard → .uniqlaw/settings.json (+ prompts/IDENTITY.md, USER.md, SOUL.md)
export TELEGRAM_BOT_TOKEN=…   # secrets are referenced by env var / file / command, never stored inline
uniqlaw doctor                # tools, settings, credentials, ports, bot-token conflicts
uniqlaw start
uniqlaw status
```

Coming from ClaudeClaw v2: have your agent follow [`docs/MIGRATE.md`](docs/MIGRATE.md) (`/uniqlaw:migrate` in Claude Code). Stop v2 first, because two pollers on one bot token fight.

As a Claude Code plugin: `/plugin marketplace add hans00/uniqlaw`, then `/plugin install uniqlaw@uniqlaw`, and use `/uniqlaw:init`, `/uniqlaw:start`, `/uniqlaw:status`, … (`/uniqlaw:help` lists them). The `uniqlaw-agents` skill teaches agents the bus tools.

## CLI

| command | |
|---|---|
| `uniqlaw init [--yes …] [--force]` | create `.uniqlaw/settings.json` (interactive; `--yes` + flags for scripts) |
| `uniqlaw doctor` | health check; exit code 1 on failures; never prints secrets |
| `uniqlaw start` / `stop` | run the daemon in the background / stop it (agent tmux sessions stay alive and are reattached) |
| `uniqlaw run` | foreground daemon (SIGHUP = reload, SIGTERM/SIGINT = stop) |
| `uniqlaw reload [--reason R] [--now]` | re-read settings.json in-process; invalid settings are refused and the running config stays |
| `uniqlaw restart [--reason R] [--in 10m \| --at 03:00] [--now] [--cancel]` | restart the daemon process (new code + settings). Both are graceful: the command returns at once, running turns finish first (`restart.drainTimeoutSec`, default 120 s), new messages wait and are replayed, and the asking session and any session whose turn was cut off get a `[uniqlaw]` notice when it is back. Agents in the operator's chat can use the `daemon_restart` tool (only in a turn the operator started; it is in the `config` tool group). If the new process doesn't come up, the old one keeps running on its current code. Under a systemd service it exits 75 for the supervisor instead (needs `Restart=on-failure`); `UNIQLAW_RESTART_MODE=exit\|spawn` forces it |
| `uniqlaw status` / `logs [--lines N]` / `ls` | daemon + sessions / log tail / all instances on this machine |
| `uniqlaw send <target> <text>` | post text to a chat, e.g. `telegram:<chatId>` |
| `uniqlaw trigger <target> <prompt>` | make a session answer its own chat |
| `uniqlaw pairing [list]` / `pairing approve <code>` / `deny <code>` / `revoke <platform> <userId>` | DM pairing: open requests, approve or deny a code, remove a paired user |
| `uniqlaw workers` / `worker start <name> --profile P [--cwd DIR] [task]` / `worker stop <name> [--forget]` | list / start / stop worker sessions |
| `uniqlaw attach <worker\|session>` / `release <…>` | take a session over in this terminal / end a takeover that didn't hand back |
| `uniqlaw dream [--dry-run]` | run the memory consolidation sweep now; `--dry-run` explains which notes would be promoted and why, without a model or writes |
| `uniqlaw mcp-shim` | stdio⇄HTTP bridge to the MCP gateway (used by providers that only accept file-configured MCP) |

All commands take `--project DIR` (default: current directory). The daemon's HTTP API keeps v2's `POST /api/send` and `/api/trigger`.

## Configuration in one glance

```jsonc
// .uniqlaw/settings.json
{
  "profiles": {
    "main":   { "provider": "claude-tmux", "model": "sonnet", "fallback": ["coder"] },
    "coder":  { "provider": "codex" },
    "vertex": { "provider": "pi", "model": "google-vertex/gemini-3-pro", "credential": "gcp" },
    "dreamer": { "provider": "claude-sdk", "model": "haiku", "permissions": { "level": "locked" } }
  },
  "credentials": { "gcp": { "kind": "gcp", "project": "my-proj", "location": "us-central1" } },
  "bindings": { "default": "main", "channels": { "discord:1234": "coder" } },
  "queue": { "mode": "steer" },
  "groups": { "mode": "mention", "historyLimit": 30, "channels": { "discord:1234": { "mode": "always", "ignoreOtherMentions": true },
    "discord:5678": { "allowFrom": ["discord:111222333"], "others": "context" } } },
  "channels": {
    "defaults": { "tools": ["chat", "memory"] },
    "telegram:123456789": { "tools": "*" },
    "discord:5678": { "tools": ["chat", "memory", "web", "files.read"] }
  },
  "workers": { "roots": ["~/Projects"], "profiles": ["main", "coder"] },
  "plugins": {
    "telegram": { "token": { "env": "TELEGRAM_BOT_TOKEN" }, "allowedUserIds": ["123456789"] },
    "heartbeat": { "interval": 60, "profile": "cheap", "replyTo": "telegram:123456789", "excludeWindows": [{ "start": "23:00", "end": "07:00" }] },
    "dreaming": { "schedule": "0 3 * * *", "profile": "dreamer" },
    "a2a": { "expose": { "main": { "description": "My assistant" } } }
  }
}
```

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — per-provider auth and per-platform bot setup
- [`docs/MIGRATE.md`](docs/MIGRATE.md) — ClaudeClaw v2 → UniQlaw, written for an agent to follow
- [`docs/architecture.md`](docs/architecture.md) — design, capability matrix, decisions, milestone status
- [`docs/spikes/M0-results.md`](docs/spikes/M0-results.md) — provider spike findings (historical)

## Repository layout

`packages/core` (contracts, runtime, bus, MCP gateway), `daemon`, `cli`, `credentials`, `scheduler`, `transcriber`, `testkit`, `claude-common`, `provider-*`, `platform-*`, `transport-a2a`. Bun workspaces; `bun test` inside a package, `bun run typecheck` at the root. Real-provider contract tests are gated behind `UNIQLAW_E2E=1`; the real whisper.cpp test runs when `UNIQLAW_WHISPER_MODEL` points at a ggml model.

## Known gaps

- Telegram, Discord, Slack and LINE are tested against local fakes of their APIs (the end-to-end tests use real agents with a fake Telegram); none has been run against the real service yet.
- `agy` and `pi` with real models, and ACP agents other than `opencode acp`, have had little live testing.
- Terminal takeover (`uniqlaw attach`) of a `codex` worker is tested with fakes only; other providers besides `claude-tmux`, `claude-sdk` and `codex` support chat `/attach` only.

Reports and fixes are welcome.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md), please report privately.

## License

[MIT](LICENSE). Some generated and vendored files carry their own licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
