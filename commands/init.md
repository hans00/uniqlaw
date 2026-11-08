---
description: Set up UniQlaw in the current project (interactive wizard → .uniqlaw/settings.json)
---

1. Run `pwd` and `echo "$HOME"`. If they are equal, STOP and ask the user to `cd` into a project directory first.
2. Make sure dependencies are installed once: `(cd ${CLAUDE_PLUGIN_ROOT} && bun install)`.
3. The wizard is interactive, so do not run it blindly. Ask the user (in chat) for:
   - provider for the main profile (claude-tmux, claude-sdk, codex, opencode, agy, pi) and model,
   - credential: provider login (default) or an API key / AWS / GCP / Azure — **only ever as a reference**: an env var name, `file:/path` or `cmd:<command>`. Never ask the user to paste a secret.
   - which chat platforms to connect, the env var holding each bot token, and the allowed user ids (an empty list means the bot ignores everyone),
   - web dashboard on/off, heartbeat on/off.
4. Then run the non-interactive form, e.g.:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts init --yes --project "$PWD" --provider claude-tmux --model sonnet --telegram-users 123456789 --telegram-token TELEGRAM_BOT_TOKEN
   ```
   Other flags: `--credential <login|anthropic-api-key|openai-api-key|gemini-api-key|openai-compatible|aws|gcp|azure>`, `--key <ENV|file:…|cmd:…>`, `--base-url`, `--region`, `--aws-profile`, `--gcp-project`, `--location`, `--service-account`, `--endpoint`, `--deployment`, `--discord-token`, `--slack-bot-token --slack-app-token`, `--line-channel-access-token --line-channel-secret`, `--<platform>-users`, `--no-web`, `--heartbeat`, `--force`.
5. If the project has a ClaudeClaw v2 config (`.claude/claudeclaw/settings.json`), suggest `/uniqlaw:migrate` instead.
6. Finish with `/uniqlaw:doctor`, then `/uniqlaw:start`.
