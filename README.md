# UniQlaw

A multi-channel agent daemon. Each chat — a Telegram DM, a Discord channel, a Slack thread, a LINE group — gets its own long-lived agent session. The agent behind it can be **Claude Code, Codex, OpenCode, Antigravity, any ACP agent, or a plain LLM API** (OpenAI, Anthropic, Gemini, Bedrock, Vertex AI, Azure OpenAI, any OpenAI-compatible endpoint), chosen per profile and per channel.

Successor to ClaudeClaw v2 (Claude-only, tmux-only). Everything is a plugin; features don't disappear when you switch provider.

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
- **Approvals on your phone**: permission prompts from any provider become buttons on the chat that triggered the work (or the operator).
- **A provider-independent message bus** exposed to every agent as MCP tools: `agents_list`, `agent_ask`, `agent_trigger`, `notify`, `task_status`, `worker_start`, `worker_stop`, plus `cron_list` / `cron_save` / `cron_delete`. Provider-native cross-session features are disabled so nothing bypasses routing.
- **A2A v1.0**: expose profiles as A2A agents; remote A2A agents show up in `agents_list` and answer `agent_ask`.
- **Workers**: a session can start another coding agent (any profile: Claude Code, Codex, OpenCode, …) in a chosen directory on the same machine with `worker_start`, and get its report back. A human can take a worker over: `/attach <worker>` from a chat (any provider) or `uniqlaw attach <worker>` in a terminal (live for `claude-tmux`; `claude-sdk` / `codex` are handed to their own CLI and handed back on exit). Allowed directories and profiles come from `workers` in settings (default: the project directory only).
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

Missing capabilities are filled in by the core (e.g. turn-boundary queueing when a provider can't steer) or rejected at startup with a clear message — never silently degraded. Details: [`docs/architecture.md`](docs/architecture.md) §5–§6, §15 (Chinese).

## Platforms

Telegram (long-poll), Discord (Gateway), Slack (Socket Mode), LINE (webhook), plus the web dashboard / HTTP API. `allowedUserIds` is required on every platform — an empty list means **nobody** can talk to the bot (v2 allowed everyone).

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.3, plus the CLI of the provider you pick (`claude` + `tmux`, `codex`, `opencode`, `agy`; `pi` needs nothing extra).

```bash
git clone <this repo> ~/Projects/uniqlaw && cd ~/Projects/uniqlaw
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

As a Claude Code plugin: install this repo as a plugin and use `/uniqlaw:init`, `/uniqlaw:start`, `/uniqlaw:status`, … (`/uniqlaw:help` lists them). The `uniqlaw-agents` skill teaches agents the bus tools.

## CLI

| command | |
|---|---|
| `uniqlaw init [--yes …] [--force]` | create `.uniqlaw/settings.json` (interactive; `--yes` + flags for scripts) |
| `uniqlaw doctor` | health check; exit code 1 on failures; never prints secrets |
| `uniqlaw start` / `stop` | run the daemon in the background / stop it (agent tmux sessions stay alive and are reattached) |
| `uniqlaw run` | foreground daemon (SIGHUP = reload, SIGTERM/SIGINT = stop) |
| `uniqlaw reload` | re-read settings.json without restarting; invalid settings are refused and the running config stays |
| `uniqlaw status` / `logs [--lines N]` / `ls` | daemon + sessions / log tail / all instances on this machine |
| `uniqlaw send <target> <text>` | post text to a chat, e.g. `telegram:<chatId>` |
| `uniqlaw trigger <target> <prompt>` | make a session answer its own chat |
| `uniqlaw workers` / `worker start <name> --profile P [--cwd DIR] [task]` / `worker stop <name> [--forget]` | list / start / stop worker sessions |
| `uniqlaw attach <worker\|session>` / `release <…>` | take a session over in this terminal / end a takeover that didn't hand back |
| `uniqlaw mcp-shim` | stdio⇄HTTP bridge to the MCP gateway (used by providers that only accept file-configured MCP) |

All commands take `--project DIR` (default: current directory). The daemon's HTTP API keeps v2's `POST /api/send` and `/api/trigger`.

## Configuration in one glance

```jsonc
// .uniqlaw/settings.json
{
  "profiles": {
    "main":   { "provider": "claude-tmux", "model": "sonnet" },
    "coder":  { "provider": "codex" },
    "vertex": { "provider": "pi", "model": "google-vertex/gemini-3-pro", "credential": "gcp" }
  },
  "credentials": { "gcp": { "kind": "gcp", "project": "my-proj", "location": "us-central1" } },
  "bindings": { "default": "main", "channels": { "discord:1234": "coder" } },
  "queue": { "mode": "steer" },
  "workers": { "roots": ["~/Projects"], "profiles": ["main", "coder"] },
  "plugins": {
    "telegram": { "token": { "env": "TELEGRAM_BOT_TOKEN" }, "allowedUserIds": ["123456789"] },
    "heartbeat": { "interval": 60, "profile": "cheap", "replyTo": "telegram:123456789", "excludeWindows": [{ "start": "23:00", "end": "07:00" }] },
    "a2a": { "expose": { "main": { "description": "My assistant" } } }
  }
}
```

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — per-provider auth and per-platform bot setup
- [`docs/MIGRATE.md`](docs/MIGRATE.md) — ClaudeClaw v2 → UniQlaw (Chinese)
- [`docs/architecture.md`](docs/architecture.md) — design, capability matrix, decisions, milestone status (Chinese)
- [`docs/spikes/M0-results.md`](docs/spikes/M0-results.md) — provider spike findings (Chinese)

## Repository layout

`packages/core` (contracts, runtime, bus, MCP gateway), `daemon`, `cli`, `credentials`, `scheduler`, `testkit`, `claude-common`, `provider-*`, `platform-*`, `transport-a2a`. Bun workspaces; `bun test` inside a package, `bun run typecheck` at the root. Real-provider contract tests are gated behind `UNIQLAW_E2E=1`.
