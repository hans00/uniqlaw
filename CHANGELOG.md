# Changelog

## 0.1.0 (unreleased)

First public version.

- Daemon with per-chat sessions for Telegram, Discord, Slack and LINE, plus a web dashboard and HTTP API.
- Providers: `claude-tmux`, `claude-sdk`, `codex`, `opencode`, `acp`, `agy`, `pi`.
- Provider-independent message bus exposed to agents over MCP (`agents_list`, `agent_ask`, `agent_trigger`, `notify`, `task_status`, `cron_*`, `worker_*`), and A2A v1.0.
- Every DM is its own session; heartbeat and cron jobs run in their own internal sessions with per-job profile/model.
- Workers: start another coding agent in a chosen directory and take it over from chat (`/attach`) or a terminal (`uniqlaw attach`).
- Credentials layer (API keys, Bedrock, Vertex AI, Azure, provider logins) with secrets stored by reference only.
- Memory: `memory/MEMORY.md` + daily notes, `memory_write` / `memory_search` / `memory_get` for every provider, CJK-capable full-text search; Claude Code's auto-memory is turned off while it is on.
- Dreaming plugin (after OpenClaw): nightly promotion of daily notes into `MEMORY.md` with rule-based gates and model-chosen add / merge / supersede / skip, validation and history; dream diary; `uniqlaw dream [--dry-run]`.
- Agent-guided migration from ClaudeClaw v2 (`docs/MIGRATE.md`), including importing Claude auto-memory.
