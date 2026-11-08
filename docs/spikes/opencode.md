# OpenCode spike (`opencode serve` 1.19.0, raw HTTP + SSE)

PoC: `poc.ts` (`bun poc.ts [S1..S7]`). Results: `out/result.md`. Raw events: `out/S*/raw.jsonl`. These files (under `spikes/opencode/`) were removed from the tree; they are in git history (the commit before "chore: prepare for open source").
Model: `opencode/nemotron-3.5-lightning-free` (a free model on OpenCode Zen). Alternate model: `nemotron-3.5-super-vl-free`.

Result: S1–S7 all ✅.

## Control interface

- One `opencode serve` = one instance. Select the project with `?directory=<abs>`. SSE via `GET /event?directory=`.
- Open a session: `POST /session { title, permission?: PermissionRule[], model?, agent? }` → `ses_…`
- Send a message: `POST /session/:id/prompt_async { parts, model?, agent?, system?, tools?: {id:bool}, noReply? }` → 204
- Interrupt: `POST /session/:id/abort`
- Permissions: SSE `permission.asked` → `POST /permission/:requestID/reply { reply: once|always|reject }`.
  The old path `/session/:id/permissions/:id` still exists, and there is also `permission.v2.asked`.
- MCP: `POST /mcp { name, config: {type:"remote", url, headers?, oauth:false} }`, added dynamically at runtime and **shared across the whole instance**.
  It can also be set at startup via `OPENCODE_CONFIG_CONTENT`.
- There is also `question.asked` (the agent asks the user a question, part of the `question` tool) → the current `AgentEvent` has no matching type (see suggested changes below).

## Native events → `AgentEvent`

| OpenCode | AgentEvent | Notes |
|---|---|---|
| `POST /session` returns id | `session` | Session ids survive server restarts (stored in `~/.local/share/opencode`) |
| `session.status {busy}` (first after sending) | `turn_start` | **Do not use the `step-start` part**: there is one for every LLM step in a run loop |
| `message.part.delta` (part type=text) | `text{delta}` | Token-by-token streaming |
| `message.part.updated` (text, `time.end` set) | `text{final}` | |
| `message.part.updated` (reasoning finished) | `thinking` | |
| `message.part.updated` (tool, state=pending/running) | `tool_start` | `input` is often `{}` while pending and complete only once running |
| `message.part.updated` (tool, state=completed/error) | `tool_end` | Permission denied → error "The user rejected permission…" |
| `permission.asked` / `permission.v2.asked` | `permission_request` | `permission` = tool category (bash/edit/…), `patterns` = command or path |
| `session.error` | `error` | Also `ProviderModelNotFoundError` and others |
| `session.idle` | `turn_end` | The reason depends on whether that turn's assistant message has `error.name=MessageAbortedError` |
| `question.asked` | (missing) | Suggest adding `input_request` |

### Pitfalls (the adapter must handle these)

1. **Duplicate or stale `session.idle` events appear after an abort.** The only reliable way to detect turn end is "send → see busy → first idle"; drop every other idle.
2. After an abort, the old assistant message's `error` is pushed again via `message.updated` in the next turn → clear the error state at turn start (busy).
3. **The bash tool's `workdir` defaults to the git worktree root**, not the `directory` parameter. On the first S2 run, the file was written to the repo root instead of `work/`.
   uniqlaw's session cwd is usually the project root, so this is mostly not a problem; but for "one subdirectory per session" isolation, you cannot rely on `directory`.
4. The list of free models is refreshed at runtime (`nemotron-3-ultra-free` disappeared midway through testing). When a model does not exist, the response is `session.error` + an immediate idle → the adapter should report `error` and not let the turn hang.

## Scenario conclusions

- **S4 inject = steer**: calling `prompt_async` while a turn is running → the new user message is admitted into the same run loop at the **next step boundary**
  (the model already saw it while thinking in step 2), and there is only one idle for the whole thing. The final reply was `DONE INJECTED`.
  → `inject: "steer"` (granularity is the step boundary, not mid-tool-execution).
- **S6 MCP is instance-level**:
  - `POST /session` has no mcp parameter. Servers added with `POST /mcp` are **visible to every session** (tool ids become `<server>_<tool>`).
  - Isolation option 1: same instance, one MCP server name per session (`uc_<sessionKey>`), then block the others with the session's
    permission ruleset `[{permission:"uc_<other>_*", pattern:"*", action:"deny"}]`. Tested: A only hit sessA.
    Downsides: not verified whether deny removes the tools from the model's tool list (if it only blocks at call time, the model still sees other sessions' tools), and the rules grow with the number of sessions.
  - Isolation option 2: disable other sessions' tools on every message with `tools: {"uc_B_uniqlaw_ping": false}`. Works in testing, but must be sent with every message.
  - Isolation option 3: **one `opencode serve` per uniqlaw session**, each with its own MCP via `OPENCODE_CONFIG_CONTENT` (tested: sessC correct).
    Cleanest; the cost is roughly one Bun runtime's memory per process.
  - Recommendation: default to option 3 (`mcp: "per-process"`); keep option 1 as an optimization for sharing an instance across many sessions.
- **S7**: the `model` field of `prompt_async` can differ per message → `modelSwitch: "live"` (really per-message).
- **S2**: permission rulesets can be set per session (`POST /session {permission}`, `PATCH /session/:id`) → maps directly onto uniqlaw's PermissionPolicy.

## Capability (§5 format)

```ts
opencode: {
  streaming: "token",
  interrupt: true,                 // POST /session/:id/abort
  inject: "steer",                 // prompt_async while busy → admitted at next step boundary
  resume: "native",                // session id persists across server restarts
  modelSwitch: "live",             // per-message model
  permissionCallback: true,        // permission.asked + /permission/:id/reply
  mcp: "per-process",              // instance-wide; per-session needs 1 serve/session (or deny-rules)
  nativeTools: false,              // (plugins exist, but out of process)
  attachments: ["image", "file"],  // FilePartInput (not tested in this spike)
  slashCommands: true,             // GET /command, POST /session/:id/command (not tested)
}
```

## Suggested changes to the design doc

1. §5.1 opencode row: MCP is confirmed instance-level → "one serve per session" is the default, not an option pending verification. Also mention dynamic addition via `POST /mcp` and the deny-ruleset alternative.
2. §6: opencode's `inject` measured as `steer` (step boundary), not `queue`.
3. §5 `AgentEvent`: add `{ type: "input_request"; id; question; options? }`, mapping to OpenCode's `question.asked`,
   ACP's `elicitation/create` and Claude's AskUserQuestion. Today there is only permission_request, which cannot express "the agent wants to ask the human a question".
4. Adapter contract tests should add: duplicate idle after abort, and a clean state for the turn after an abort.
