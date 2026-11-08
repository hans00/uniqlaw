# M0 spike results (2026-11-02)

Scenario definitions are in `docs/spikes/README.md` (S1 basic, S2 tool + permissions, S3 interrupt, S4 inject, S5 resume,
S6 MCP identity binding, S7 model switch). Each adapter's event mapping and details are in `docs/spikes/<adapter>.md`;
the summary for the two Claude adapters is `docs/spikes/claude-summary.md`. The raw records (`spikes/<adapter>/out/result.md`)
and PoC code are in git history (the commit before "chore: prepare for open source").

## Overview

| adapter | version | S1 | S2 | S3 | S4 | S5 | S6 | S7 | Notes |
|---|---|---|---|---|---|---|---|---|---|
| claude-sdk | SDK 0.3.x / CLI 2.1.316, haiku | ✅ | ✅ | ✅ | ✅ steer | ✅ | ✅ | ✅ live | Also checked: slash commands, plugins/skills/hooks all load |
| claude-tmux | CLI 2.1.316, haiku | ✅ | ✅ pane | ✅ | ✅ steer | ✅ | ✅ | ✅ `/model` | Also checked: cross-resume with the SDK ✅ |
| codex | app-server 0.166.0, gpt-6-luna | ✅ | ✅ | ✅ | ✅ steer | ✅ | ✅ per-session | ✅ per turn | Must disable `memories` |
| opencode | serve 1.19.0, nemotron 3.5 (free) | ✅ | ✅ | ✅ | ✅ steer | ✅ | ✅ per-process | ✅ per message | MCP is shared across the whole instance |
| acp (generic) | SDK 2.2, `opencode acp` | ✅ | ✅ | ✅ | ✅ (agent behavior, not a protocol guarantee) | ✅ load replays | ❌ **identity leak** | ✅ config option | Gemini CLI has been replaced by Antigravity CLI; not supported |
| agy | 1.4.12 stream-json | ✅ | ⚠️ no callback | ✅ SIGINT + respawn | queue only | ✅ | ✅ cwd file + shim | spawn | Official headless mode exists |
| pi | pi-coding-agent 1.4.0 | ✅ | ✅ | ✅ | ✅ steer + followUp | ✅ | ✅ per-session + native | ✅ live | **faux provider**; real model pending credentials |

## Answers to the open M0 questions

| # | Question | Answer |
|---|---|---|
| 0 | Can claude-tmux and claude-sdk resume each other's sessions? | ✅ Both directions work, history is kept. Find the jsonl by globbing on the id (`~/.claude/projects/*/<id>.jsonl`) |
| 1 | How complete is claude-sdk relative to the TUI ecosystem? | ✅ `settingSources: ["user","project","local"]` → 13 plugins / 134 skills / 188 slash commands / user MCP all load, hooks fire, and a slash command sent as a prompt runs |
| 2 | Is a subscription account allowed under the SDK? | Technically it works (`apiKeySource=none`, using the CLI's claude.ai OAuth). Official docs: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." → Decided: uniqlaw only provides compatibility and support; usage is the user's own responsibility (architecture goal 8, §13 #6) |
| 3 | Queueing semantics of Claude streaming input | Each message can set `priority`: `next`/unset = mid-turn steer, `later` = queued after the turn, `now` = interrupt and run immediately |
| 4 | codex `turn/steer` parameters | `{threadId, expectedTurnId, input}`, a true mid-turn steer; when idle it returns `-32600 no active turn to steer` |
| 5 | Official agy headless mode | ✅ Exists: `--input-format stream-json --output-format stream-json -p=`. stdin has no control channel (`control_request` returns not supported yet). No terms restricting programmatic use were found (the official terms were not checked either) |
| 6 | pi SDK project trust | It neither prompts nor hangs, but **without a resolver it loads protected `.pi/` resources by default** → you must pass `reload({ resolveProjectTrust })` |

## Key cross-adapter findings

1. **v2's `native` queue mode is really steer.** Messages pasted into the Claude TUI while it is busy are delivered mid-turn, not queued until the turn ends. uniqlaw changes the modes to `queue / steer / interrupt`, and turn-boundary queueing is always done by core.
2. **Do not trust "per-session MCP" claims; prove it with tests.** The ACP protocol says MCP is per-session, but `opencode acp` actually shares it per process: when two sessions use the same name, A ends up calling with B's token. Contract tests must include cross-session MCP isolation; any adapter that fails gets one process per session.
3. **There are more channels that bypass the bus than expected:**
   - Claude: `disallowedTools` works, but `messaging_socket_path` is still open and may receive messages from outside sessions.
   - Claude: user hooks (for example claude-mem) carry context across sessions in the same cwd.
   - Codex: `memories` shares memory across threads.
4. **The adapter must always set the permission mode explicitly.** A user's global `defaultMode: "auto"` makes Claude skip `canUseTool` entirely.
5. **Permission denial semantics differ**: in claude-tmux a denial ends the whole turn; in the other adapters only that tool call fails → added a `denyEndsTurn` capability, and core adds a turn to make the behavior uniform.
6. **Resume may replay history** (ACP `session/load`); the adapter must suppress it so replayed events never reach the Output Pipeline.
7. **Providers that can only configure MCP through files** (agy) solve identity binding with a stdio shim plus a token in an environment variable. This approach generalizes.
8. **Bus tools may be deferred** (Claude's ToolSearch); set them to always-load or list the tool names in the system prompt.
9. **New event `input_request`**: ACP / MCP elicitation needs a "ask the human for more information" event separate from permission confirmation.

## Not yet verified / follow-ups

| Item | When |
|---|---|
| pi with a real model (needs an OpenAI key / Vertex ADC / `pi /login`) | Rerun `spikes/pi/poc.ts` (in git history) once credentials are available |
| agy API key / Vertex environment variables, config directory override (needed for multiple instances) | M3 |
| Real tests of each adapter with the three major cloud credentials (§10.1 table) | M2–M3 |
| agy `--remote-control` (may have a permission callback) | M3 |
| codex `dynamicToolCall` / `item/tool/call` (client-provided native tools) | M3 |
| How to disable Claude's native messaging socket | M1 |
| How to configure always-load for Claude bus tools | M1 |
| Attachment (image/file/audio) input for each provider | M1–M3, during each adapter's implementation |

All of the above conclusions have been folded into `docs/architecture.md` (v0.3): §5 capability interface, §5.1 capability matrix, §5.2, §6 polyfill, §8.3 shim, §13 new open issues.
