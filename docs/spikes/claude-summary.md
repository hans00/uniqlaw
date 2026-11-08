# M0 summary: Claude adapters (claude-sdk + claude-tmux)

Date 2026-11-02 · Claude Code 2.1.316 · Agent SDK 0.3.316 · model haiku.
Details: `docs/spikes/claude-sdk.md`, `docs/spikes/claude-tmux.md`. The raw results (`spikes/claude-sdk/out/result.md`, `spikes/claude-tmux/out/result.md`) are in git history (the commit before "chore: prepare for open source").
All 7 standard scenarios pass on both adapters.

## (0) Session interop: ✅ both directions

- tmux creates → SDK `resume` with the same id: the SDK kept the same `session_id` and recalled the codeword (TANGERINE-42).
- SDK creates → tmux `claude --resume <id>`: it recalled the codeword (MANGO-77).
- The two adapters write the same jsonl format to the same `~/.claude/projects/<cwd-hash>/<id>.jsonl`. SDK `setModel` is stored as a `/model` local-command entry, the same as the TUI's.
- **Gotcha:** resuming from a different cwd works, but it appends to the *original* file under the original cwd hash while each entry records the new cwd. Locate the jsonl by session id (glob), never by computing the hash from the current cwd.
- **Conclusion:** per-profile adapter choice is real. One session can move between tmux and the SDK, and migrated v2 sessions work with either.

## (1) SDK feature completeness: ✅ effectively at parity with the TUI

With `settingSources: ["user","project","local"]`:
- **Loaded** (from system/init): 13 plugins (no errors), 134 skills, 188 slash commands including plugin commands, and the user, plugin and claude.ai MCP servers.
- **Hooks:** user hooks fire (SessionStart `hook_started`/`hook_response` frames).
- **Slash commands:** plugin and builtin slash commands run when sent as plain prompts (`/claudeclaw2:help`, `/context`). `supportedCommands()` and `commands_changed` give the list for platform registration.
- **Not checked:** interactive-only TUI commands (`terminal_slash_commands`, e.g. statusline/exit) are meaningless in a daemon anyway.

## (2) Auth: works on the subscription, but policy says use an API key

- Under the SDK, init reports `apiKeySource: "none"` with no `ANTHROPIC_API_KEY` set. The bundled CLI reused the existing claude.ai (Max) OAuth login.
- The docs (overview and quickstart, identical note) say:
  > "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in this document instead."
- **Documented routes:** `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_ANTHROPIC_AWS` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`.
- **For the user to decide:** claude-tmux runs the user's own interactive CLI, which is the same situation as v2 today. claude-sdk on a subscription is the case the note addresses. Recommend making the auth mode explicit per profile (`auth: "cli-login" | "api-key" | "bedrock" | "vertex"…`).

## (3) SDK inject semantics: three modes via `SDKUserMessage.priority`

| priority | behaviour (measured) |
|---|---|
| `next` / unset | **mid-turn steer**: delivered within the running turn as a `queued_command` attachment ("The user sent a new message while you were working: …"); same turn, tools continue |
| `later` | **queued**: runs as its own turn after the current turn's `end_turn` |
| `now` | **interrupt + send**: aborts the running turn (`terminal_reason=aborted_tools`), then runs the message |

claude-tmux's "type while busy" produces the identical `queued_command` mid-turn delivery, so v2's `native` mode was a steer all along. Caveat: once, Haiku distrusted the mid-turn note as possible injection, so steer obedience depends on the model.

## disallowedTools ["ListAgents","SendMessage"]: ✅ removed on both

- **SDK:** 35 → 33 tools.
- **tmux:** `claude -p` with the same flags lists neither tool, and the model reports NONE.
- ⚠️ init still shows `messaging_socket_path`, so other Claude sessions on the machine may still be able to send messages **into** a uniqlaw session. Needs an M1 check on how to disable it.

## Capabilities (§5 ProviderCapabilities shape, measured)

```ts
const claudeSdk: ProviderCapabilities = {
  streaming: "token",            // stream_event text_delta
  interrupt: true,               // q.interrupt() (receipt)
  inject: "steer",               // priority next; also "later" (queue) and "now" (interrupt+send)
  resume: "native",              // options.resume, same id
  modelSwitch: "live",           // q.setModel()
  permissionCallback: true,      // canUseTool (requires an explicit permissionMode)
  mcp: "per-session",            // options.mcpServers per query()
  nativeTools: true,             // createSdkMcpServer in-process (not exercised here; S6 used HTTP)
  attachments: ["image", "file"],// MessageParam content blocks (not exercised)
  slashCommands: true,           // prompts "/x" + supportedCommands()
};

const claudeTmux: ProviderCapabilities = {
  streaming: "segment",          // jsonl flush per content block
  interrupt: true,               // Esc → "[Request interrupted by user]"
  inject: "steer",               // paste while busy → queued_command mid-turn (no turn-boundary-only queue natively)
  resume: "native",              // --resume <id>; we pick the id up front with --session-id
  modelSwitch: "live",           // "/model x" + "Switch model?" dialog handled by the pane poller
  permissionCallback: true,      // pane dialog detection → keys (deny ENDS the turn, unlike the SDK)
  mcp: "per-session",            // --mcp-config per process = per session
  nativeTools: false,
  attachments: ["image", "file"],// via file paths in the prompt (v2 behaviour; not exercised)
  slashCommands: true,           // full TUI
};
```

## Design-doc corrections (`docs/architecture.md`)

1. §5.1/§6: the claude-sdk inject is no longer ⚠️. It is `steer`, with `later` and `now` variants. Consider widening `inject` to a set: `{steer, queue, interruptSend}`. claude-tmux is also `steer`, not `queue`.
2. §5.2: session interop is verified. Remove the ⚠️ and add the "locate jsonl by id, not by cwd hash" rule.
3. §10: adapters **must always pin the permission mode**. The user-level `defaultMode` (here `auto`) otherwise silently overrides uniqlaw's policy on both adapters.
4. §6/§10: add a provider-specific deny semantic (`denyEndsTurn`: tmux true, SDK false).
5. §8.1: disabling `ListAgents`/`SendMessage` is not enough. The native inbound messaging socket stays open. Add an M1 task to disable it or treat inbound native messages as `origin=system` and suppress them.
6. §8.3: MCP bus tools may be deferred behind ToolSearch. Use always-load or name them in the system prompt.
7. New: **user-level hooks and plugins apply to every uniqlaw session** (e.g. claude-mem replayed one session's context into the next in the same cwd). Profiles need a choice: `settingSources` with or without `user`, or a per-channel cwd.
8. §5.2 claude-tmux: the init-watch pattern table needs **folder-trust**, and the busy regex must match the spinner shape (v2's "esc to interrupt" no longer appears in 2.1.316). (#28881)
9. §13: auth policy for claude-sdk on a subscription is a user decision; quote above.
