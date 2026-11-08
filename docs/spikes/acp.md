# Generic ACP adapter spike (`@agentclientprotocol/sdk` 2.2.0, ACP v1)

PoC: `poc.ts` (`bun poc.ts <agent> [S1..S7]`) is **one** generic client; agents differ only in the launch command and env in the `AGENTS` table.
Results: `out/<agent>/result.md`. Both live under `spikes/acp/` in git history (the commit before "chore: prepare for open source"); they were removed from the tree.

## What was actually tested

| agent | Status |
|---|---|
| `opencode acp` (1.19.0) | S1–S7 all run (results in `out/opencode/result.md`) |
| `gemini --experimental-acp` (0.28.2) | Only got as far as `initialize`. `session/new` failed: "This client is no longer supported for Gemini Code Assist for individuals… migrate to Antigravity". This machine has no `GEMINI_API_KEY` / Vertex → could not run a turn. Also, 0.28.2 **has no `--acp`**, only `--experimental-acp` |
| `agy` (Antigravity CLI 1.4.12) | **No native ACP mode.** `agy --help` offers `--print` + `--input-format stream-json --output-format stream-json`, `--conversation <id>` (resume), `--remote-control`, `agy mcp`, `--dangerously-skip-permissions`, `--mode`, `--model`. `~/.gemini/antigravity-acp/` (containing a token file and a conversations db) looks like state left behind by some community ACP bridge; there was no matching executable to verify it with. The in-depth agy investigation was handed to another fork |
| `cursor-agent` | Not logged in, old version (2026.01), no ACP subcommand → skipped |

**Conclusion: the generic ACP client's protocol layer is fully validated on opencode; other ACP agents could not be tested on this machine because of account / version limits.**

## SDK usage notes (2.2.0)

- `acp.client({name}).onNotification(...).onRequest(...).connect(acp.ndJsonStream(stdinWritable, stdoutReadable))`
  → `ClientConnection`; call the agent with `conn.agent.request(method, params)` / `conn.agent.notify(...)`.
- **Handlers receive a context `{ method, params, signal, agent }`, not the params themselves** (the first PoC version missed every `session/update` because of this).
- The stable entry point has no `session/set_model`; model selection goes through **`session/set_config_option`** (the option with `category:"model"` in `configOptions`).
  The unstable entry point also has `session/resume|close|fork|list|delete`, `providers/*`, `elicitation/*`.
- The client declares the `fs`/`terminal` capabilities as false → the agent reads/writes files and runs commands with its own tools (which is what uniqlaw wants).

## Native events → `AgentEvent`

| ACP | AgentEvent | Notes |
|---|---|---|
| `session/new` returns `sessionId` | `session` | |
| client sends `session/prompt` | `turn_start` | ACP has no turn-start event; the client synthesizes it |
| `session/update` `agent_message_chunk` | `text{delta}` | On tool_call or turn end, flush the accumulated text as `text{final}` |
| `agent_thought_chunk` | `thinking` | |
| `tool_call` | `tool_start` | `kind` (execute/edit/read/…), `title`, `rawInput` |
| `tool_call_update` status=completed/failed | `tool_end` | |
| `session/request_permission` (agent→client request) | `permission_request` | options have a kind: `allow_once/allow_always/reject_once/reject_always`; reply with `{outcome:{outcome:"selected",optionId}}` |
| `session/prompt` resolves with `stopReason` | `turn_end` | `end_turn`→done, `cancelled`→interrupted; `usage` carries token counts |
| `session/prompt` rejects | `error` + `turn_end{error}` | |
| `available_commands_update` | (none; can feed platform slash-command registration) | |
| `elicitation/create` (unstable) | (missing) → suggest `input_request` | |

## Scenario conclusions (opencode acp)

- S1 ✅ Streams chunk by chunk; `usage` is returned.
- S2 ✅ `session/request_permission` allow/reject both work (bash/edit must be set to `ask` via `OPENCODE_CONFIG_CONTENT`).
- S3 ✅ `session/cancel` (notification) → the prompt returns `stopReason:"cancelled"`, and the session stays usable.
- S4: **ACP v1 has no steer method.** But if you **send another `session/prompt` concurrently** while a turn is running, opencode admits it into the current run loop
  (effectively a steer); both prompts end with `end_turn`, and the final reply contains INJECTED.
  → This is **agent-defined behavior**, not guaranteed by the protocol. Other agents might return an error, queue it, or cancel the previous one.
  The adapter must not assume it; the capability must come from measured contract-test results (default `inject: false`, upgraded only after testing).
- S5 ✅ New process + `session/load` → history is replayed as `session/update` (the client must drop the replayed content and not forward it to the platform), and then the conversation can continue.
  opencode also declares `sessionCapabilities.resume` (unstable `session/resume`, no replay).
- S6 ❌ **Major finding: in ACP semantics `mcpServers` is per-session, but opencode acp actually shares it across the process:**
  - Two sessions in the same process both use the name `uniqlaw` → the later registration overwrites the earlier one, and **session A calls with B's token** (identity leak).
  - With a unique name per session (`uniqlaw_<token>`) → the call results are correct, but **A's tool list also shows B's tools**
    (the model listed both `uniqlaw_acpA_uniqlaw_ping` and `uniqlaw_acpB_uniqlaw_ping`); it just happened to pick the right one.
  - → The generic ACP adapter **cannot trust an agent's per-session MCP isolation**. Default: **one uniqlaw session = one agent process**.
    Only agents that pass the "cross-session MCP isolation" contract test may share a process across sessions.
- S7 ✅ `session/set_config_option {configId:"model", value}` → takes effect immediately and returns the updated configOptions.

## Capability (§5 format)

**Conservative defaults** for the generic ACP adapter (actual values are adjusted from the `initialize` response and contract-test results):

```ts
acp: {
  streaming: "token",                 // agent_message_chunk (actual granularity is up to the agent)
  interrupt: true,                    // session/cancel
  inject: false,                      // no steer in the protocol; concurrent-prompt behavior is agent-defined (opencode measured: steer)
  resume: "native",                   // requires agentCapabilities.loadSession (or unstable sessionCapabilities.resume)
  modelSwitch: "live",                // requires a category:"model" entry in configOptions; otherwise false
  permissionCallback: true,           // session/request_permission
  mcp: "per-process",                 // per-session in the protocol, but implementations can't be trusted (opencode leaked in testing)
  nativeTools: false,
  attachments: ["image"],             // per promptCapabilities
  slashCommands: true,                // available_commands_update
}
```

Measured values for opencode via ACP: `inject: "steer"` (concurrent prompt); everything else as above.

## Suggested changes to the design doc

1. §5.1 acp row: change "`session/new` can carry mcpServers (per-session)" to "per-session in the protocol, but implementations cannot be trusted; default to one process per session".
2. §6: ACP inject is actually decided by the agent. The adapter detects at startup (or via contract tests) whether a concurrent `session/prompt` steers, queues or errors.
   Do not hard-code `inject=false`; but untested agents must default to `queue` mode (polyfill).
3. §6 add a row: when `resume` uses `session/load`, it **replays history**; the adapter must suppress the replayed events so they never reach the Output Pipeline.
4. §5 `AgentEvent`: add `input_request` (`elicitation/create`).
5. Antigravity: `agy` has no native ACP → only two options remain: a dedicated `provider-agy` (stream-json, validated by another fork), or a community bridge.
   Gemini CLI no longer works with personal OAuth accounts (needs an API key or Vertex) → demote Gemini CLI from "primary ACP target" in the docs.
6. Add a contract test: **cross-session MCP isolation** (two sessions each mount their own gateway token; check that A's tool list has none of B's tools and that A's calls carry only A's token).
   This applies to **all** providers (opencode serve is also shared per instance).
