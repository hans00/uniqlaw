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
- Voice transcription (optional, `transcription.engine`): `whisper` (local whisper.cpp via `@fugood/whisper.node`, audio decoded with ffmpeg) or `transcribe-api` (OpenAI-compatible `/audio/transcriptions`). By default only for providers that can't take audio; the transcript is added to the message and the file stays attached. Off by default: the agent handles audio files itself.
- DM pairing (after OpenClaw): a stranger who DMs the bot gets a one-time code; an operator approves it with `/pair approve <code>` or `uniqlaw pairing approve <code>`. Paired users live in `state.db`, are accepted like `allowedUserIds` but are never operators, and can be removed with `uniqlaw pairing revoke`. Open requests are capped (`pairing.maxPending`) and expire (`pairing.ttlMinutes`); `pairing.enabled: false` turns it off.
- `send_file` bus tool: agents post local files (image, audio, voice note, video, document) to their own or another chat without calling platform APIs. Telegram, Discord and Slack (needs the `files:write` scope); limited to the project, the session's directory, the temp dir, `workers.roots` and `files.roots`, up to `files.maxMB`.
- Group modes: `mention` (default; unaddressed messages are kept as context for the next turn) or `always`, with `ignoreOtherMentions`, per-channel settings (`groups.channels`) and `/activation`. Discord's v2 per-channel `requireMention` / `ignoreOtherMentions` map onto them; unaddressed messages are no longer dropped.
- Agent-guided migration from ClaudeClaw v2 (`docs/MIGRATE.md`), including importing Claude auto-memory.
