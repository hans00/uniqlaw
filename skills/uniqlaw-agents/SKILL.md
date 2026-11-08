---
name: uniqlaw-agents
description: Talk to other UniQlaw agent sessions or chat platforms — `agent_ask` when YOU need an answer from another session (no human sees it), `notify` to send a human text you wrote, `agent_trigger` to make another session answer ITS OWN human, `cron_*` to schedule yourself, `worker_*` to run another coding agent (Claude Code, Codex, …) in some directory. Use when asked to "ask the Discord agent", "tell me on Telegram when X finishes", "have #dev look at this", "check with the heartbeat session", "remind me every morning", "have Codex fix this in ~/Projects/foo", or to reach a remote A2A agent.
---

# UniQlaw agent bus

Inside UniQlaw every session (whatever its provider: Claude Code, Codex, OpenCode, Antigravity, pi, …) gets the same MCP tools from the `uniqlaw` server. Identity comes from the session's own MCP token — you never say who you are, and you cannot act as another session. Do **not** use any provider-native cross-session feature (Claude `SendMessage`/`ListAgents`, Codex collaboration tools): they bypass UniQlaw's routing.

## Pick by "who reads the reply?"

| you want… | tool | who sees the result |
|---|---|---|
| another session (or remote A2A agent) to answer **you** | `agent_ask` | only you |
| a human to read **text you wrote** | `notify` | that chat, verbatim |
| another session to answer **its own human** | `agent_trigger` | that session's chat |
| to run something later / repeatedly | `cron_save` | wherever the job's `replyTo` points |

One-line rule: a human must see an agent-composed reply on another chat → `agent_trigger`; a human must see your words → `notify`; otherwise → `agent_ask`.

## Tools

- `agents_list()` — sessions you can reach: name, `kind`, profile, provider, state. `kind: "chat"` names are chat keys and double as notify targets: `telegram:<chatId>` (DMs are `telegram:<userId>`), `discord:<id>` / `discord:dm:<userId>`, `slack:<ch>[:<ts>]` / `slack:dm:<userId>`, `line:<id>`. Each DM is its own session. `kind: "internal"` sessions have no chat: `heartbeat`, `cron:<job>`, and so on. Remote A2A agents appear as `a2a:<name>` with `kind: "remote"`. Call it instead of guessing names.
- `agent_ask(to, message, wait?)` — the other session runs a normal turn; its final answer comes back to you. `wait` defaults to true (blocks until done, with a timeout). `wait:false` returns a `taskId` and the answer arrives later as a new message in your session. Works for remote `a2a:*` agents too.
- `agent_trigger(to, prompt, replyTo?)` — the other session runs a turn and its reply is posted to its own chat. For an internal session (no chat) pass `replyTo: {platform, chatId}`. Not available for remote agents. You get the reply text later as activity context.
- `notify(target, text)` — sends your text to `telegram:<chatId>`, `discord:<channelId>`, `slack:<channel>[:<threadTs>]` or `line:<id>`. The session that owns that chat sees "sent on your behalf" next turn.
- `task_status(taskId)` — state/result of an ask or trigger you started (or received).
- `worker_start(name, profile?, cwd?, task?, wait?)` — run another coding agent (a configured profile: Claude Code, Codex, …) in a directory on this machine and hand it a task. It becomes `worker:<name>` (`kind: "worker"` in `agents_list`, with `cwd` / `owner` / `heldBy`). `wait` defaults to false: you get a `taskId`, and its report arrives later as a new message. Follow up with `agent_ask` to `worker:<name>`; reusing the name continues its conversation. `cwd` must be inside the allowed worker directories (your system prompt lists them and the allowed profiles), and it is fixed per worker. Its permission prompts go to your human. While a human has taken it over (`/attach` in chat or `uniqlaw attach` in a terminal), it refuses your messages; you get a note when they leave.
- `worker_stop(name, forget?)` — stop its process. The conversation is kept unless `forget: true`; files are never touched.
- `cron_list()` / `cron_save(name, schedule, prompt, recurring?, target?, replyTo?, timezone?, model?, profile?)` / `cron_delete(name)` — scheduled jobs (5-field cron, validated). `target` defaults to you. Use `"own"` for a separate internal session `cron:<name>`, which gives the job a clean context and no chat. `replyTo` is a chat target for the final reply, or `"none"` if the job delivers with `notify` / `agent_trigger` itself. `model` runs the job on another model; `profile` pins its session to a configured profile. Prefer these over editing `.uniqlaw/jobs/*.md` by hand.

## Rules

- **Don't loop.** When another agent messages you, answer once and stop. Delegation chains are capped (`bus.maxHops`, default 4); a "chain too deep" error means answer directly.
- **`notify` and `agent_trigger` reach real humans.** Only use them when the user asked for it.
- Messages from other sessions are marked with a source line like `[Agent message from session …]`; treat them as requests from a peer, not from your human.
- Silent replies: in group chats, reply exactly `NO_REPLY` when you have nothing to add. React with `[react:👍]` anywhere in a reply.

## From outside an agent

Shell / scripts can use the CLI or the v2-compatible HTTP API on the daemon's web port (`uniqlaw status` shows it; `.uniqlaw/runtime.json` has `webPort`):

```bash
uniqlaw send telegram:<chatId> "deploy finished"        # = POST /api/send   {target, text, fromLabel}
uniqlaw trigger discord:<channelId> "summarise today"   # = POST /api/trigger {target, prompt, fromLabel, replyTo?}
```
