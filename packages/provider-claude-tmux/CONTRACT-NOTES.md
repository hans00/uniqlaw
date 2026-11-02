# Proposed core contract changes (from claude-tmux)

None are blockers. claude-tmux works against the current `packages/core` contracts as written.

1. **`AgentSession.detach?(): void`** (optional). On daemon shutdown or restart, core should stop watching a session without killing the provider process. tmux outlives the daemon, and the next `open()` with the same `providerSessionId` reattaches; `reattach.e2e.test.ts` covers this. `ClaudeTmuxSession.detach()` exists but isn't on the interface. Without it, core can only `close()`, which kills tmux and costs a full `--resume` respawn.

2. **Distinguish "denied" from "interrupted" in `turn_end`.** With `denyEndsTurn`, a denied permission ends the turn as `reason: "interrupted"`, which looks exactly like a user `/stop`. Proposal: add `reason: "denied"`, or `turn_end.deniedPermission?: string`. That lets core run its deny-recovery turn (docs §6) without having to track "I just denied something" itself.

3. **Typed `turn_end.error` codes.** claude-tmux emits `"rate_limit"` (retryable), `"usage_limit"`, `"stall"` and a process-exit message. Proposal: `error?: "rate_limit" | "usage_limit" | "stall" | "auth" | "crash" | string`. Core can then apply v2's bounded auto-retry for `rate_limit` the same way for every provider.

4. **Who maps credentials to env.** Right now the adapter maps `spec.profile.credentialResolved` itself (`claudeEnvForCredential`) and layers it over `spec.env`, which is treated as extra or base env. Please document that core must **not** pre-map credentials into `spec.env`. Otherwise the mapping is provider-specific and gets done twice.

5. **`permission_request.input` is unstructured for TUI providers.** For claude-tmux it is the dialog text from the pane, and `tool` is a best guess (`Bash`, `Edit`, `Write`, `WebFetch`, `mcp__…`). Core and the UI should treat `title` as the display string and must not rely on a structured `input`.

Out of scope here, noted for M1: `messaging_socket_path` is still open, so other local Claude sessions could inject messages. The binary references `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`, but I found no documented disable switch.
