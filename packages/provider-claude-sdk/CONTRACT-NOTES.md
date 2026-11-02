# claude-sdk: notes for core and testkit

No core changes are required: `unsolicited_turn.source` already exists in `packages/core/src/provider.ts`.

1. **The session id is chosen up front.** New sessions pass `sessionId: <uuid>` to `query()` and resumed ones pass `resume: <providerSessionId>`, so `session` is emitted right after `open()`, before the first prompt. It is the same id and the same jsonl that claude-tmux uses; `test/interop.e2e.test.ts` passes in both directions.
2. **`detach()` is not implemented on purpose.** There is no out-of-process survivor, so core falls back to `close()`. On restart the session resumes from the jsonl, so no context is lost, but each daemon restart costs one `--resume` spawn.
3. **Steer reliability depends on the model.** Delivery is correct: `priority: "next"` lands mid-turn within the same turn, every time. But Haiku sometimes treats the bare mid-turn text as prompt injection arriving in the tool output and ignores it. This caused 1 failure across 4 runs of the contract's S4. In production, core prefixes messages with `[timestamp]` and `[Telegram from …]` lines, which should help. Suggestion for testkit: make S4's steer text look like a user message (for example with the core prefix), or retry S4 once.
4. **`allowTools` shadows `canUseTool`.** A bare tool name in `PermissionPolicy.allowTools` auto-approves it before the callback runs (the SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). This is intended: allow means don't ask. User-level allow rules in `~/.claude/settings.json` shadow it the same way while `settingSources` includes `"user"`. The profile option `userSettings: false` removes them.
5. **Error codes.** `result` errors map to `turn_end.error` values `rate_limit`, `usage_limit` or `auth`. Anything else carries the raw error text. Retrying is core's job.
6. **`nativeTools` is false.** It would need JSON Schema → zod conversion for `createSdkMcpServer`. The gateway MCP covers the bus tools.
