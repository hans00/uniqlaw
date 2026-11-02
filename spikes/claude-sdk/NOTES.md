# claude-sdk spike notes

`poc.ts` drives `query()` in streaming-input mode (an `AsyncIterable<SDKUserMessage>` queue) with
`settingSources: ["user","project","local"]`, `disallowedTools: ["ListAgents","SendMessage"]`, model haiku.
`slash.ts` checks slash commands sent as prompts. Results are in `out/result.md`.

## Native → AgentEvent mapping

| SDK message | AgentEvent |
|---|---|
| `system/init` (`session_id`) | `session` |
| first `stream_event` / `assistant` after idle | `turn_start` (synthesized; the SDK has no explicit turn-start) |
| `stream_event` `content_block_delta.text_delta` | `text{delta}` (real token streaming) |
| `assistant` content `text` | `text{final}` (one message per completed block) |
| `assistant` content `thinking` | `thinking` (text is empty: thinking is redacted / summarized off) |
| `assistant` content `tool_use` | `tool_start` |
| `user` content `tool_result` | `tool_end` |
| `canUseTool(tool, input, {toolUseID,…})` callback | `permission_request`; the promise result is the decision |
| `result` success/`completed` | `turn_end{done}` |
| `result` `error_during_execution`, `terminal_reason=aborted_streaming\|aborted_tools` | `turn_end{interrupted}` |
| `system/hook_*`, `status`, `commands_changed`, `task_*`, `thinking_tokens`, `rate_limit_event` | ignore, or route to telemetry (`commands_changed` → refresh platform slash-command list) |

## Findings

1. **Feature completeness vs the TUI.** With the three setting sources, the SDK loads:
   - all user plugins (13, no `plugin_errors`), skills (134), slash commands (188, including plugin commands like `claudeclaw2:*`) and MCP servers (user, plugin and claude.ai connectors);
   - user hooks, which fire: SessionStart `hook_started`/`hook_response` frames appear in the stream.

   Plugin and builtin slash commands (`/claudeclaw2:help`, `/context`) work when sent as plain prompts. There is also `q.supportedCommands()`, and `commands_changed` is pushed whenever the list changes. Practically, the SDK covers what we used the TUI for.
2. **Auth.** `apiKeySource: "none"` means the bundled CLI used the existing claude.ai (Max) OAuth login with no API key set; the transcript shows "Claude Max". **Policy:** the overview and quickstart docs both say *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in this document instead."* So it works technically; whether a self-hosted personal daemon counts as a "third party product" is a policy question for the user. API key / Bedrock / Vertex / Foundry are the documented routes.
3. **Inject.** `SDKUserMessage.priority` gives three distinct semantics:
   - `next` (and unset): delivered **mid-turn** as a `queued_command` attachment. The model sees "The user sent a new message while you were working: …". This is a true steer.
   - `later`: queued as its own turn after `end_turn`.
   - `now`: aborts the running turn (`aborted_tools`), then runs the message.

   Caveat: in one unset run Haiku distrusted the mid-turn note as possible prompt injection. Steer obedience depends on the model and the wording.
4. **Interrupt.** `interrupt()` returns a receipt (`still_queued`). The init `capabilities` include `interrupt_receipt_v1`, `interrupt_cancel_queued_v1` and `interrupt_send_now_v1`.
5. **The permission mode must be pinned.** The user's `~/.claude/settings.json` has `defaultMode: "auto"`. Without an explicit `permissionMode`, the classifier, not `canUseTool`, decides. The adapter must always set the mode from the uniqlaw PermissionPolicy.
6. **The MCP bus tools get deferred.** The gateway tool sat behind `ToolSearch` (an extra model hop and an extra token cost). For bus tools, look for an always-load option (the server manifest / `alwaysLoad`) or tell the model the tool names in the system prompt.
7. **`disallowedTools` works** (35 → 33 tools). But init still exposes `messaging_socket_path`: the native messaging socket is open for **inbound** messages from other Claude sessions on the machine. Peers outside uniqlaw could still `SendMessage` into a uniqlaw session. Investigate disabling it (env/setting) in M1.
8. **User hooks leak context between sessions.** The user's claude-mem hooks inject "Resumed context from previous session" into any new session in the same cwd, so separate uniqlaw channels sharing one cwd can see each other's history through user hooks. Options: per-profile `settingSources` (drop `user`), per-channel cwd, or accept it and document it.
9. **Session jsonl is identical** to the TUI's (same `~/.claude/projects/<cwd-hash>/<id>.jsonl`). `setModel` shows up as a `/model` local-command entry. See `../claude-SUMMARY.md` for interop.
