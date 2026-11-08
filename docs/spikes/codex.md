# Codex adapter spike — notes

Surface: `codex app-server` (codex-cli 0.166.0), newline-delimited JSON-RPC 2.0 over stdio.
Authoritative types: `codex app-server generate-ts --out schema` (generated into `schema/`, 664 v2 files).
README (`readme.md`, fetched from openai/codex main) has almost nothing on steer/approvals; the generated types and the experiments are the evidence.

Files: `rpc.ts` (JSON-RPC client), `poc.ts` (scenarios; `bun poc.ts [S1..S7]`), `probe.ts` (model/list), `run1.log`, `out-run2.log`, `out/` (events/raw/result). These files (under `spikes/codex/`) were removed from the tree; they are in git history (the commit before "chore: prepare for open source").

## Handshake

`initialize {clientInfo:{name,title,version}, capabilities:{experimentalApi:true, requestAttestation:false}}` → then notification `initialized`.
`experimentalApi:true` is needed for several fields/methods. Use the process's existing login (`codexHome` reported in the response). **Never pass `--startup-sign-out`.**

## Native → AgentEvent mapping

| native | AgentEvent |
|---|---|
| `thread/start` / `thread/resume` response `thread.id` | `session{providerSessionId}` |
| notif `turn/started {turn}` | `turn_start{turnId}` |
| notif `item/agentMessage/delta {itemId,delta}` | `text{delta, segmentId=itemId}` (token-level) |
| notif `item/completed {item.type="agentMessage", text}` | `text{final, segmentId}` |
| notif `item/reasoning/textDelta` / `summaryTextDelta` | `thinking` |
| notif `item/started` with item.type ∈ commandExecution, fileChange, mcpToolCall, dynamicToolCall, webSearch, collabAgentToolCall | `tool_start{id,name,input}` |
| notif `item/completed` same types (`status`: completed / failed / declined) | `tool_end{ok}` |
| server request `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` (sandbox escalation), legacy `execCommandApproval` / `applyPatchApproval` | `permission_request`; respond to the JSON-RPC id |
| notif `turn/completed {turn.status}` completed / interrupted / failed | `turn_end{reason: done / interrupted / error}` |
| notif `error {error, willRetry}` | `error{fatal: !willRetry}` |
| notif `thread/settings/updated`, `thread/tokenUsage/updated` | (model / usage bookkeeping) |
| server request `mcpServer/elicitation/request`, `item/tool/requestUserInput` | not exercised; would map to `permission_request` (or an INPUT_REQUIRED-like prompt to the operator) |

Approval responses:
- command: `{decision: "accept" | "acceptForSession" | "decline" | "cancel" | {acceptWithExecpolicyAmendment…}}`
- fileChange: `accept | acceptForSession | decline | cancel`
- permissions: `{permissions: GrantedPermissionProfile, scope}`

Every server request needs a response, or the turn hangs.

## Answers to the directive

- **`turn/steer`**: params `{threadId, expectedTurnId, input: UserInput[], clientUserMessageId?}` → `{turnId}`. This is real mid-turn injection: the same turn continues, and the input becomes a `userMessage` item inserted at the next model-step boundary (after the in-flight tool call finishes). `expectedTurnId` is a precondition, and it errors if no turn is active (`-32600 no active turn to steer`). So the adapter needs to handle a race at turn end by falling back to `turn/start`. Per its own doc comments, `turn/start` on an active turn also "adds input to an active turn" (several params are "Ignored when this request steers an already-active turn"). Not exercised; prefer explicit `turn/steer`.
- **Approvals**: arrive as server→client JSON-RPC requests (see the mapping). Policy is set by `approvalPolicy` (`untrusted | on-request | never | {granular}`) plus `sandbox` / `sandboxPolicy` on `thread/start`, or per turn on `turn/start` (persists for later turns).
- **Interrupt**: `turn/interrupt {threadId, turnId}`. `turn/completed` arrives with status `interrupted` about 12 ms later, and the thread stays usable.
- **Resume**: `thread/resume {threadId}` works in a brand-new process; threads persist under CODEX_HOME unless `ephemeral:true`. Options like model, cwd, approvalPolicy, config and developerInstructions can be re-supplied at resume. On a thread that is already running, resume = rejoin (also useful to read the effective model).
- **MCP per thread**: `thread/start {config: {mcp_servers: {<name>: {url, default_tools_approval_mode: "approve"}}}}`. The `config` field is a per-thread config override map (same keys as config.toml). This was verified with two threads in one process seeing different tokens → `mcp: "per-session"`. No need for `-c` at process spawn or a CODEX_HOME copy.
- **Model switch**: `turn/start {model, effort}`. This is live and sticky for later turns; it emits `thread/settings/updated`. No dedicated settings-update request exists in 0.166 (the research report's guess about `thread/settings/update` was wrong). `model/list` enumerates models.
- **Built-in cross-session / subagent features** (`codex features list`):
  - `multi_agent` (stable, **on**): in-thread subagents (`collabAgentToolCall` / `subAgentActivity` items). Per architecture §8.1 this is session-internal and allowed. Disable with `--disable multi_agent` or per thread `config:{features:{multi_agent:false}}` (the per-thread form is unverified).
  - `memories` (stable, **on**): cross-thread memory. This leaks context across uniqlaw sessions/profiles, so the adapter should disable it (`config.features.memories=false`).
  - `agent_message_board` and `wake_on_agent_messages` are "under development", off. They look like future native cross-thread messaging, and the adapter must force them off when they ship (contract test).
- **System prompt**: `thread/start {developerInstructions}` appends; `baseInstructions` replaces.

## Gotchas found

1. Under `approvalPolicy:"untrusted"` with a **read-only** sandbox, an approved command still runs inside the read-only sandbox and fails (`Read-only file system`). "accept" approves running the command; it does not escalate the sandbox. Use workspace-write with `writableRoots` or `on-request`. Sandbox escalation is the separate `item/permissions/requestApproval`.
2. MCP tools default to needing approval. With `approvalPolicy:"never"` the call fails with "MCP tool call requires approval, but approval policy is never". Set `default_tools_approval_mode:"approve"` on uniqlaw's own gateway server (valid values: `auto | prompt | writes | approve`).
3. Per-turn overrides (model, approvalPolicy, sandboxPolicy, cwd, effort) persist for all later turns ("this turn and subsequent turns"). The adapter must re-send its defaults on every turn instead of assuming a one-turn override.
4. `item/commandExecution` runs under the user's login shell (`/usr/bin/zsh -lc`), so shell rc noise (pyenv) shows up in output.
5. Lots of unrelated notifications (`configWarning`, `remoteControl/status/changed`, `account/*`). Filter them by method, or suppress them with `initialize.capabilities.optOutNotificationMethods`.

## Capability row (§5 shape)

```ts
codex: {
  streaming: "token",
  interrupt: true,
  inject: "steer",
  resume: "native",
  modelSwitch: "live",
  permissionCallback: true,
  mcp: "per-session",          // thread/start config.mcp_servers
  nativeTools: false,          // there are `dynamicToolCall` items + server request `item/tool/call` — client-provided tools may be possible; not verified
  attachments: ["image", "audio"],  // UserInput: image/localImage/audio/localAudio (not exercised)
  slashCommands: false,        // skills exist (`skills/list`, UserInput {type:"skill"}) but no /command system over the protocol
}
```

## Design-doc corrections (docs/architecture.md)

- §5.1 codex row: remove the "⚠️ `turn/steer` params / how to change model" caveat. Steer = `{threadId, expectedTurnId, input}`, which is true mid-turn injection; model is set per turn via `turn/start.model` (sticky).
- §5.1 / §6: codex `mcp` is **per-session** via `thread/start.config.mcp_servers`, so one app-server process can host many uniqlaw sessions. UniQlaw's gateway entry must set `default_tools_approval_mode:"approve"`.
- §5.2 "disable native cross-session primitives": for codex, disable `memories`, and pin `agent_message_board` / `wake_on_agent_messages` off. `multi_agent` stays allowed (session-internal).
- §8.2 / §4 Origin: codex `turn/start` already has `turnTrigger`, `parentTurnId` and `rootTurnId` for delegated work. Map uniqlaw origin/hop chains onto these for nicer native history (optional).
- New adapter rule (generic): per-turn overrides can be sticky, so adapters send the full effective settings on every turn.
- Possible future: `nativeTools` via `dynamicToolCall` / `item/tool/call` (client-implemented tools) would let the bus skip the MCP hop for codex. Worth a follow-up spike; not needed for M1.
