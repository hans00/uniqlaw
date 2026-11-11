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
- `/profile [name|reset]`: switch a chat to another profile. Same-provider (and claude-tmux ↔ claude-sdk) switches keep the session; otherwise the conversation is handed over as raw transcript (`profileSwitch.handoffMaxChars`), and switching back resumes the earlier session with what ran meanwhile. On a usage limit the owner is asked whether to switch to a `fallback` profile (the failed message is re-sent); others get the error.
- Voice transcription (optional, `transcription.engine`): `whisper` (local whisper.cpp via `@fugood/whisper.node`, audio decoded with ffmpeg) or `transcribe-api` (OpenAI-compatible `/audio/transcriptions`). By default only for providers that can't take audio; the transcript is added to the message and the file stays attached. Off by default: the agent handles audio files itself.
- DM pairing (after OpenClaw): a stranger who DMs the bot gets a one-time code; an operator approves it with `/pair approve <code>` or `uniqlaw pairing approve <code>`. Paired users live in `state.db`, are accepted like `allowedUserIds` but are never operators, and can be removed with `uniqlaw pairing revoke`. Open requests are capped (`pairing.maxPending`) and expire (`pairing.ttlMinutes`); `pairing.enabled: false` turns it off.
- `send_file` bus tool: agents post local files (image, audio, voice note, video, document) to their own or another chat without calling platform APIs. Telegram, Discord and Slack (needs the `files:write` scope); limited to the project, the session's directory, the temp dir, `workers.roots` and `files.roots`, up to `files.maxMB`.
- Fix: a per-channel `groups.channels.<key>` entry no longer resets unset fields (`mode`, `historyLimit`, `ignoreOtherMentions`, `allowFrom`, `others`) to their defaults; they come from the global `groups` settings.
- Group modes: `mention` (default; unaddressed messages are kept as context for the next turn) or `always`, with `ignoreOtherMentions`, per-channel settings (`groups.channels`) and `/activation`. Discord's v2 per-channel `requireMention` / `ignoreOtherMentions` map onto them; unaddressed messages are no longer dropped.
- Per-channel capabilities (`channels`): each chat gets tool groups (`chat`, `memory`, `web`, `files.read`, `files.write`, `bash`, `agents`, `cron`, `worker`, `xsession`, `notify`, `config`; `"*"`, `deny`). The MCP gateway only lists and accepts the granted tools; claude-tmux / claude-sdk get matching `--tools` / `--disallowedTools` / `--strict-mcp-config`; other providers refuse to open a chat whose built-in tools are restricted. A policy change respawns a reattached claude-tmux session. No `defaults` entry = unrestricted, so existing installs keep their behavior.
- Admin-level tool groups (`bash`, `files.write`, `cron`, `worker`, `xsession`) are documented as full access and warned about at startup when a restricted chat gets one; restricted chats can't read `.uniqlaw/` with Claude's file tools.
- Group wake rules: `groups.allowFrom` (platform user ids allowed to wake the agent, checked in core on the immutable id) and `groups.others` (`context` / `ignore` for messages that don't wake it).
- Agent-guided migration from ClaudeClaw v2 (`docs/MIGRATE.md`), including importing Claude auto-memory.

### Fixes

- claude-tmux: a permission dialog that opened while the daemon was down (pane neither busy nor ready on reattach) was never forwarded, so the turn stalled for `turn.stallTimeoutSec`. It is now detected on the first poll and sent to the operator.
- claude-tmux: a reattached claude whose launch flags no longer match the profile (permission mode, model, tools, …) is respawned with `--resume` once idle; the conversation is kept. The flags are fingerprinted per session at spawn.
- A turn still running when the daemon stops or reloads now keeps its reply: the session is reopened on startup and the reply goes to the chat that asked. Also fixes `this.turn.toolBubble` errors when a turn ends while a tool status is being posted.
- CLI commands find the project from any subdirectory, including `.uniqlaw/` itself (`init` still uses the current directory).
