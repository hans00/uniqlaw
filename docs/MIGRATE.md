# Migrating from ClaudeClaw v2 to UniQlaw (an agent runbook)

> This document is written for an **agent** (Claude Code, Codex, …) to follow. It is not a fixed script. Every v2 install is a little different (keys left over from older versions, hand-edited files, v1 leftovers), so the agent reads the actual files, maps them using the tables below, and confirms with the user before writing anything.
>
> In Claude Code: `/uniqlaw:migrate`.

## Hard rules

1. **Two programs must never use the same bot token at the same time.** Telegram allows only one long-poller, and Discord/Slack will reply twice. Stop v2 before writing and before starting UniQlaw.
2. **Treat v2 files as read-only** (`.claude/claudeclaw/`, `prompts/`, `CLAUDE.md`, Claude's auto-memory directory). Write all output under `.uniqlaw/` and `memory/`, so rolling back to v2 stays a no-op.
3. **Never print tokens or secrets** (including in summaries, diffs and logs). When you mention one, say only something like "telegram.token: copied".
4. **Show the user the plan first and write only after they confirm.** If `.uniqlaw/settings.json` already exists, diff it first and ask whether to overwrite.
5. Always run `uniqlaw doctor` after writing.

## 0. Preflight

Assume the v2 project is at `$V2` (usually the same directory UniQlaw will run in, for example `~/claudeclaw`).

- It is a v2 project only if `$V2/.claude/claudeclaw/settings.json` exists.
- Check whether v2 is running: is the pid in `$V2/.claude/claudeclaw/daemon.pid` still alive (`kill -0 <pid>`)? If it is running, you may read and plan, but **ask the user to stop it before writing** (`/claudeclaw2:stop` or `kill -TERM <pid>`).
- If you see `$V2/.claude/claudeclaw/session.json`, or `sessions.json` has the v1 shape `{ "threads": … }`, those are v1 leftovers. Ask the user to upgrade to v2 first with v2's `/claudeclaw2:migrate`. This guide does not handle v1.

## 1. v2 files to read

| v2 file | Contents | Destination |
|---|---|---|
| `.claude/claudeclaw/settings.json` | All settings | `.uniqlaw/settings.json` (§2) |
| `.claude/claudeclaw/sessions.json` | channelKey → Claude session | `sessions` table in `.uniqlaw/state.db` (§3) |
| `.claude/claudeclaw/inbox/*.jsonl` | Messages not yet delivered to a session | `pending_input` in `state.db` (§4, optional) |
| `.claude/claudeclaw/jobs/*.md` | Cron jobs | Copy to `.uniqlaw/jobs/` (same format) |
| `prompts/**` | IDENTITY / USER / SOUL… | No change if it is the same directory; otherwise copy it over |
| `CLAUDE.md` | Project instructions | No change; claude reads it from the cwd itself |
| `~/.claude/projects/<sanitized cwd>/memory/` | Claude Code auto-memory (v2's memory) | `memory/` (§4b, ask first) |

## 2. settings.json mapping

The full UniQlaw schema is in `packages/core/src/config.ts`; each plugin's settings are in the `configSchema` of its own package. For fields v2 does not set, let UniQlaw use its defaults. Do not fill them in.

| v2 | UniQlaw | Notes |
|---|---|---|
| `timezone` | `timezone` | Copy as is. cron understands v2 formats like `"UTC+8"`, but ask the user whether to switch to an IANA name (`"Asia/Taipei"`) |
| `model` | `profiles.main.model` | Set `profiles.main.provider` to `"claude-tmux"` (same behavior as v2) |
| `agentic` (modes, hysteresis…) | `profiles.main.options.agentic` | Copy the whole block; model routing reads this format directly |
| `security.level` | `profiles.main.permissions.level` | locked / strict / moderate / unrestricted; treat any other value as moderate |
| `security.allowedTools` / `disallowedTools` | `permissions.allowTools` / `denyTools` | |
| `security.skipPermissions: true` | `permissions.approval.mode: "auto-allow"` | Tell the user clearly: every tool is approved automatically |
| `approval.enabled: false` | `permissions.approval.mode: "auto-deny"` | v2 left the dialog hanging; UniQlaw denies instead |
| Any other case | `permissions.approval.mode: "ask-operator"` | |
| `approval.timeoutSeconds` | `permissions.approval.timeoutSec` | |
| `approval.survey` | (unused) | claude-tmux handles it itself (skipped by default) |
| `queue.mode` | `queue.mode` | **`"native"` → `"steer"`** (v2's native is really mid-turn steer); copy other values (queue / interrupt) as is |
| `queue.debounceMs` / `cap` / `dropPolicy` | Same names | |
| `sessionCleanup.*` | `sessionCleanup.*` | Same names |
| `backgroundNotify.mode` | `backgroundNotify.mode` | last / all / off |
| `web.enabled` / `host` / `port` | `web.*` | Keep v2's 4632 so old skills calling `/api/send` and `/api/trigger` keep working |
| `telegram.messageStream.mode` | `output.stream` | Global in UniQlaw; other platforms' `messageStream` stays in their own plugin block |
| `telegram.token` | `plugins.telegram.token` | See "Secrets" below |
| `telegram.allowedUserIds` | `plugins.telegram.allowedUserIds` | Convert to a string array. **If it is empty, ask the user** (see below) |
| `telegramPollSeconds` | `plugins.telegram.pollSeconds` | |
| `discord` / `slack` / `line` blocks | `plugins.discord` / `plugins.slack` / `plugins.line` | Copy the whole block (the adapters accept v2 field names), then add `enabled`; migrate only if there is a token. Discord `channels.<id>.requireMention` / `ignoreOtherMentions` keep working; a channel without `requireMention` now follows the top-level `groups.mode` (default `mention`), so set `"requireMention": false` (or `groups.channels["discord:<id>"].mode: "always"`) where v2 answered every message |
| `heartbeat` | `plugins.heartbeat` | Copy as is; set `enabled` from v2's value, or ask the user. **Note**: v2's heartbeat runs in `global` (the DM conversation), while UniQlaw runs it by default in its own internal session `heartbeat`, which cannot see what the user said in DMs. To keep v2 behavior, set `target` to the user's DM key (for example `telegram:<id>`). To use a separate session, set `replyTo` to the user, or set it to `"none"` and let the heartbeat decide via `notify` / `agent_trigger` whether to speak |
| `jobs/*.md` | `plugins.cron` | cron is on by default; nothing to write. **Note**: a v2 job without `target` runs in `global` (DMs), while in UniQlaw it runs in the job's own internal session `cron:<job>`. If a job needs the DM conversation context, add `target: telegram:<id>` to that job file (ask the user) |
| `api`, `fallback`, `sessionTimeoutMs` | (unused) | Keys left over from v1; tell the user they were skipped |
| Any other unknown key | (unused) | List them for the user; do not guess |

Finally, add `"bindings": { "default": "main" }`.

**Allowlist (most important)**: in v2 an empty `allowedUserIds` means "everyone is allowed"; in UniQlaw an empty list means "**everyone is denied**" (fail closed). If any platform's list is empty, stop and ask the user which user ids to add. Do not fill them in yourself, and do not leave the list empty just to make things work. If the user does not know either, set that platform to `enabled: false` for now.

**Secrets**: tokens may be copied as plain strings (the schema accepts them), but recommend that the user switch to a SecretRef, for example `{"env": "TELEGRAM_BOT_TOKEN"}`, `{"file": "~/.config/uniqlaw/tg"}`, `{"command": "pass show tg"}`. If they switch, have the user set up the environment variable or file themselves. The agent must not handle the token value.

After writing, validate the schema (this does not print the contents):

```bash
bun -e 'import {parseSettings} from "<repo>/packages/core/src/config.ts"; parseSettings(JSON.parse(await Bun.file(".uniqlaw/settings.json").text())); console.log("ok")'
```

## 3. Reattach v2's Claude sessions

v2's `sessions.json` looks like this (each key is a channelKey: `global`, `telegram:<chatId>`, `discord:<channelId>`, `slack:<channel>[:<thread>]`, `line:<id>`):

```json
{ "telegram:-100123": { "sessionId": "<uuid>", "tmuxSession": "claudeclaw-…", "createdAt": "…", "lastActivityAt": "…", "multiparty": true } }
```

Write each entry as one session row in `state.db`, with `provider` set to `claude-tmux` and `providerSessionId` set to v2's `sessionId`. If `state.db` already has the same channelKey, skip it; do not overwrite. Example (adjust to the actual contents):

```bash
bun -e '
import { StateStore } from "<repo>/packages/core/src/state.ts";
const v2 = JSON.parse(await Bun.file(".claude/claudeclaw/sessions.json").text());
const store = new StateStore(".uniqlaw/state.db");
const have = new Set(store.listSessions().map((s) => s.channelKey));
const ms = (v, d) => typeof v === "number" ? v : (Date.parse(v) || d);
const target = (k) => { const m = k.match(/^(telegram|discord|line):(.+)$/); if (m) return { platform: m[1], chatId: m[2] };
  const s = k.match(/^slack:([^:]+)(?::(.+))?$/); return s ? { platform: "slack", chatId: s[1], ...(s[2] ? { threadId: s[2] } : {}) } : null; };
for (const [key, v] of Object.entries(v2)) {
  if (!v?.sessionId) continue;
  const channelKey = v.channelKey || key;
  if (have.has(channelKey)) { console.log("skip", channelKey); continue; }
  const created = ms(v.createdAt, Date.now()), t = target(channelKey);
  store.upsertSession({ channelKey, profile: "main", provider: "claude-tmux", providerSessionId: v.sessionId,
    multiparty: v.multiparty === true, createdAt: created, lastActivityAt: ms(v.lastActivityAt, created),
    lastTarget: t ? JSON.stringify(t) : null, adapterState: JSON.stringify({ v2TmuxSession: v.tmuxSession ?? null }) });
  console.log("imported", channelKey);
}
store.close();'
```

**Rename v2's `global` (DM) session.** v2 funnels all DMs into `global`; in UniQlaw every DM is its own session (`telegram:<userId>`, `discord:dm:<userId>`, `slack:dm:<userId>`, `line:<userId>`), so if you copy it as is, no DM will reach `global` again. When importing:

- Only one person DMs the bot (usually `allowedUserIds` has a single id): change the `global` row's channelKey to that person's DM key (for example `telegram:<that id>`) and point `lastTarget` at them too. Their next DM then resumes the original conversation.
- Several people: ask the user who should inherit the old conversation; everyone else starts a new session.
- The user does not want to reattach it: copy it as `global`. It becomes an internal session (visible in `agents_list`, reachable with `agent_ask`), but it no longer receives DMs.

When the first message arrives, claude-tmux resumes the conversation with `--resume <sessionId>` on UniQlaw's own tmux socket (`tmux -L uniqlaw-<instanceId>`). If a tmux session left over from v2 is still running the same session, it is closed first so that two claude processes never write to the same jsonl. Conversation history lives in `~/.claude/projects/*/<sessionId>.jsonl` and is not lost.

## 4. Inbox (optional)

`inbox/*.jsonl` holds messages v2 had not yet delivered to a session (the filename is the channelKey with `:` replaced by `_`, for example `telegram_-100123.jsonl` → `telegram:-100123`; for slack, turn every `_` back into `:`). It is usually empty or stale. Show the user the count and timestamps first, and ask whether to carry them over. If yes, write one entry per line:

```ts
store.pushPending(channelKey, "external", { source: "v2-inbox", ts, kind, from, text, note });
```

At the start of the next turn, the runtime puts them into the prompt using v2's format ("you sent…", "trigger response…").

## 4b. Memory (ask first)

v2 had no memory of its own; the agent used Claude Code's auto-memory in `~/.claude/projects/<sanitized $V2>/memory/` (the sanitized name is the absolute path with every character other than letters and digits replaced by `-`, e.g. `/home/me/claudeclaw` → `-home-me-claudeclaw`). UniQlaw has its own memory in `$V2/memory/` and **turns Claude's auto-memory off** while it is on (`memory.nativeMemory: false`), so without this step the agent stops seeing what it remembered.

Show the user the file count and total size, then, if they agree:

1. Copy every file to `$V2/memory/imports/claude-code/` (keep names; never move or delete the originals). These are searchable with `memory_search` / `memory_get` but not injected.
2. If `$V2/memory/MEMORY.md` doesn't exist yet, copy the auto-memory `MEMORY.md` (the index Claude kept in context) to `$V2/memory/MEMORY.md`, and rewrite its `[[name]]` / relative links to `imports/claude-code/<file>` so they still resolve. Keep it under 24 KB (`memory.maxInjectBytes`); if it is larger, tell the user rather than cutting it.
3. Look for v2 cron jobs that maintain memory by hand (e.g. a nightly "dream" job that edits the auto-memory directory). Point them out and suggest `plugins.dreaming` instead (`"dreaming": { "profile": "<a locked profile>" }`); don't delete or rewrite those jobs yourself. A job that edits files in the old directory would keep editing files UniQlaw no longer reads.

If the user wants to keep Claude's auto-memory as well, set `"memory": { "nativeMemory": true }`; then there are two memories and the agent may write to either.

## 5. Verify and start

```bash
uniqlaw doctor --project "$V2"   # tools, credentials, port, bot token conflicts, whether v2 is still running
uniqlaw start  --project "$V2"
uniqlaw status --project "$V2"
uniqlaw logs   --project "$V2"
```

Finally, report to the user: what was migrated, what was skipped (and why), and what they need to handle themselves (allowlist, SecretRef, timezone).

## Rolling back to v2

v2's files were never touched, so:

```bash
uniqlaw stop --project "$V2"
tmux -L uniqlaw-<instanceId> kill-server   # instanceId: see `uniqlaw status`
# then start v2 with /claudeclaw2:start
```
