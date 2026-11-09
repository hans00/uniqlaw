# Installing UniQlaw

## 1. Base

```bash
curl -fsSL https://bun.sh/install | bash        # Bun ≥ 1.3
git clone https://github.com/hans00/uniqlaw.git ~/Projects/uniqlaw && cd ~/Projects/uniqlaw
bun install && bun link                          # `uniqlaw` on PATH
cd ~/my-agent-project && uniqlaw init && uniqlaw doctor
```

Secrets are always **references** in `settings.json`: `{"env": "VAR"}`, `{"file": "~/.secrets/x"}` or `{"command": "pass show x"}` (works with 1Password / pass / vault CLIs). `uniqlaw init` refuses pasted secrets; `uniqlaw doctor` checks that every reference resolves without printing values.

Provider child processes only get a minimal environment plus their own profile's credential — not the daemon's full environment.

## 2. Providers

Pick one or more; each profile names a `provider` and optionally a `credential` (see `credentials` in settings). Without a credential the provider's own CLI login is used.

### claude-tmux / claude-sdk (Claude Code)
- Needs `claude` on PATH; `claude-tmux` also needs `tmux`.
- Auth: your Claude Code login (`claude` → `/login`), or a credential: `anthropic-api-key`, `aws` (Bedrock), `gcp` (Vertex AI), `azure` (AI Foundry), or `provider-login` with a `home` (separate `CLAUDE_CONFIG_DIR`, e.g. a second account per instance). Which auth you use, and whether it fits the service's terms, is up to you.
- UniQlaw always pins the permission mode and disables Claude's native `SendMessage` / `ListAgents`.
- Your user-level `~/.claude/settings.json` is loaded by default; its allow rules auto-approve tools before UniQlaw asks. Set profile option `userSettings: false` (claude-sdk) to drop user settings.
- Each new working directory triggers Claude's folder-trust prompt; claude-tmux accepts it automatically.

### codex
- Needs `codex` on PATH, logged in (`codex login`) — or a credential: `openai-api-key`, `openai-compatible`, `azure` (API key; Entra ID is rejected). API-key credentials use a dedicated model provider, so your ChatGPT login is untouched.
- UniQlaw disables Codex memories and agent messaging (`--disable`). Codex's built-in collaboration tools cannot be removed; they only see their own thread.
- Your global Codex MCP servers (`~/.codex/config.toml`) are loaded into UniQlaw threads.

### opencode
- Needs `opencode` on PATH; auth via `opencode auth login` or a credential.
- Each session runs its own `opencode serve` with config/data dirs under `.uniqlaw/`; your global opencode config is ignored unless profile option `userConfig: true`. Note: opencode still loads `~/.claude/skills` and `~/.agents/skills`.

### acp (any ACP agent)
- `plugins.acp.command` is the agent command (default `["opencode", "acp"]`). One process per session by default (`shareProcess: true` only for agents that pass the isolation test). Mid-turn steer is off unless `steer: "concurrent-prompt"` is set and the agent supports it.

### agy (Antigravity CLI)
- Needs `agy` on PATH and an `agy` login. **The login is kept in the system keyring, so every UniQlaw instance on the machine uses the same Google account** — `HOME` isolation (`isolateHome`) only separates config/history.
- No interactive approvals in headless mode: commands are pre-allowed from the profile's permission policy; anything else is auto-denied and reported in chat.
- `gemini-api-key` (`GEMINI_API_KEY`) and Vertex ADC (`AGY_ADC_AUTH`) are documented by agy but untested with UniQlaw.

### pi (LLM APIs with UniQlaw's own harness)
- Runs in-process; no CLI needed. Profile `model` is `"<provider>/<model>"`; credentials: `openai-api-key`, `anthropic-api-key`, `gemini-api-key`, `openai-compatible` (Ollama, vLLM, llama.cpp, OpenRouter…), `aws` (Bedrock), `gcp` (Vertex AI: ADC or service-account file), `azure` (Azure OpenAI).
- Skills from `~/.agents/skills` load by default (`skills: false` to disable). Project `.pi/` resources are not loaded unless trusted.

## 3. Platforms

Every platform needs `allowedUserIds` (empty = nobody). `operatorUserIds` (default: the allowed users) receive approval prompts and system notices.

### Telegram
1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token into an env var (e.g. `TELEGRAM_BOT_TOKEN`).
2. Find your numeric user id (e.g. message [@userinfobot](https://t.me/userinfobot)).
3. `"telegram": { "token": {"env": "TELEGRAM_BOT_TOKEN"}, "allowedUserIds": ["<id>"] }`. For groups, disable privacy mode in BotFather or mention the bot.

### Discord
1. Create an application + bot in the Developer Portal; enable the **Message Content** privileged intent.
2. Invite it with scopes `bot` and `applications.commands` (permissions: read/send messages, add reactions, read history).
3. `"discord": { "token": {"env": "DISCORD_BOT_TOKEN"}, "allowedUserIds": ["<your user id>"], "channels": { "<channelId>": { "enabled": true } } }`. Whether the bot answers every message or only when mentioned is set in the top-level `groups` settings (default: only when mentioned).

### Slack
1. Create an app, enable **Socket Mode**, create an app-level token with `connections:write` (`xapp-…`).
2. Bot scopes (typical): `chat:write`, `reactions:write`, `app_mentions:read`, `im:history`, `channels:history`, `groups:history`, `files:read`, `files:write` (for `send_file`), `users:read`; subscribe to `message.im`, `message.channels`, `app_mention` events. Install to the workspace (`xoxb-…`).
3. `"slack": { "botToken": {"env": "SLACK_BOT_TOKEN"}, "appToken": {"env": "SLACK_APP_TOKEN"}, "allowedUserIds": ["U…"] }`.

### LINE
1. Create a Messaging API channel; issue a channel access token; note the channel secret.
2. LINE needs a public HTTPS webhook: put a reverse proxy / tunnel in front of `webhookPort` + `webhookPath` (default `/line/webhook`) and set that URL in the LINE console.
3. `"line": { "channelAccessToken": {"env": "LINE_CHANNEL_ACCESS_TOKEN"}, "channelSecret": {"env": "LINE_CHANNEL_SECRET"}, "webhookPort": 8787, "allowedUserIds": ["U…"] }`.

## 4. Optional pieces

- **Web dashboard / HTTP API**: on by default at `127.0.0.1` (port auto-assigned; `uniqlaw status` shows it). Binding a non-loopback host requires `web.token`.
- **A2A**: `"a2a": { "expose": { "main": { "description": "…" } }, "remotes": { "research": { "url": "https://…", "bearer": {"env": "…"} } } }`. Non-loopback exposure requires `auth.bearerTokens`.
- **Voice transcription**: by default a voice note reaches the agent as a file path and the agent handles it. To add a transcript to the message instead (for providers that can't take audio: Claude Code, pi), pick an engine:
  - Local whisper.cpp: `"transcription": { "engine": "whisper", "language": "auto" }` plus `"plugins": { "whisper": { "model": "models/ggml-large-v3-turbo-q5_0.bin" } }`. Download a ggml model from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) (`ggml-base.bin` is small and fast; `large-v3-turbo` is much better for Chinese). Needs `ffmpeg` on PATH. `@fugood/whisper.node` is installed with UniQlaw (optional dependency, prebuilt for macOS/Linux/Windows); set `"variant": "cuda"` or `"vulkan"` for GPU builds.
  - An OpenAI-compatible API: `"transcription": { "engine": "transcribe-api" }` plus `"plugins": { "transcribe-api": { "key": { "env": "OPENAI_API_KEY" }, "model": "whisper-1" } }`. Set `baseUrl` for Groq (`https://api.groq.com/openai/v1`, model `whisper-large-v3`) or a local server.
  - `transcription.when: "always"` also transcribes for providers that accept audio (Codex); `maxSeconds` skips long clips. `uniqlaw doctor` checks ffmpeg, the model file and the native module.
- **DM pairing**: on by default. A stranger who DMs the bot gets a code; you approve it with `/pair approve <code>` from your own chat or `uniqlaw pairing approve <code>`. `"pairing": { "enabled": false }` turns it off.
- **Several instances on one machine**: just use separate project directories. Ports are auto-assigned, tmux sockets are per instance, and starting a second instance with the same bot token is refused. `uniqlaw ls` lists them.
