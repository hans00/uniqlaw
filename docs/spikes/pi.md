# pi (`@earendil-works/pi-coding-agent` 1.4.0 SDK) spike notes

> The PoC code and raw results (`spikes/pi/`: `poc.ts`, `out/`) were removed from the tree; they are in git history (the commit before "chore: prepare for open source").

## Precondition: a fake provider stands in for the model

This machine had no LLM credentials pi could use directly:
- `~/.pi/agent` has no `auth.json`, and there are no API key environment variables.
- No local OpenAI-compatible server (11434 / 8080 / 1234 / 8000 all closed).
- I wanted to check whether codex's OAuth token or Vertex ADC could be reused, but auto-mode blocked those credential reads, and I did not work around it.

So the model is pi-ai's built-in **`fauxProvider`**. Its responses can be a factory (generated dynamically from the context and model), which amounts to a programmable fake LLM.
- **Verified**: the harness mechanics themselves, including events, tool gate, interrupt, steer/followUp, persistence and resume, MCP, native tools, model switch, project trust.
- **Not verified**: real model behavior, such as whether it calls tools as prompted, and the Vertex or OpenAI auth flows.
- Running a real model needs one of the following:
  - `OPENAI_API_KEY`
  - Vertex: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` plus ADC
  - Running `pi /login` once in an isolated agent dir (for example openai-codex or github-copilot)
  - A local OpenAI-compatible endpoint

## Conclusion: building our own harness on the pi-coding-agent SDK is feasible, and it has the most complete capabilities

| Item | How to wire it |
|---|---|
| Create a session | `createAgentSession({ cwd, model, modelRuntime, resourceLoader, settingsManager, sessionManager, customTools })`, entirely in-process, no subprocess |
| Isolation | Pass your own `agentDir`, `SettingsManager.inMemory()`, `ModelRuntime.create({ authPath, modelsPath: null })`. ⚠️ **You must also set `PI_CODING_AGENT_DIR`**, because the MCP OAuth store calls `getAgentDir()` directly and ignores the resource loader's `agentDir`. Without it, a run writes `mcp-auth.json` into the real `~/.pi/agent/`. |
| Permissions (Approval Broker) | In an inline extension: `pi.on("tool_call", async e => ok ? undefined : { block: true, reason })`. It can `await` indefinitely, so it can wait for an operator to press a button. Built-in tools, native tools and MCP tools **all** go through this hook. If the handler throws, it fails closed (blocks). |
| Per-session MCP | In an inline extension, call `pi.registerMcpServer("uniqlaw", { url: gw.url(token), exposure: "direct" })`, plus `createMcpExtension()` and `session.bindExtensions({})`. **No config file needed at all.** The tool name is `mcp__uniqlaw__uniqlaw_ping`. |
| Native tools | `customTools: [defineTool({ name, parameters: Type.Object(...), execute })]` (schema via typebox). Bus tools can be registered this way directly, without going through MCP. |
| Project trust (M0 item 6) | SDK mode **neither prompts nor hangs**. ⚠️ **Without a resolver, it loads protected resources under `.pi/` by default** (tested: `.pi/APPEND_SYSTEM.md` was loaded, with in-memory settings). To control it programmatically, call `resourceLoader.reload({ resolveProjectTrust: async () => boolean })`; both false and true behaved as expected. Alternatively, let an extension handle the `project_trust` event. provider-pi **must pass a resolver explicitly**, driven by uniqlaw's profile settings, and must not rely on the default. |

## Native events mapped to `AgentEvent`

| pi `AgentSessionEvent` | AgentEvent |
|---|---|
| (after creation) `session.sessionId` | `session` |
| `agent_start` | `turn_start` |
| `message_update` + `assistantMessageEvent.type=text_delta` | `text{delta}` |
| `message_update` + `thinking_delta` | `thinking` |
| `message_end` (assistant) | `text{final}`; when `stopReason === "aborted"`, mark the turn as interrupted |
| `tool_execution_start` / `tool_execution_end{isError}` | `tool_start` / `tool_end` |
| our `tool_call` handler | `permission_request` (emitted by the adapter itself) |
| **`agent_settled{aborted}`** | `turn_end`. Do not use `agent_end`, because retries or queued work may still follow |
| `queue_update{steering, followUp}` | Can be used to show "message queued" |

## Test results (see out/result.md, 8/8 ✅)

| # | Result |
|---|---|
| S1 | text_delta streams token by token. |
| S2 | Allow → bash runs and the file is created. Deny → the tool result becomes `isError`, the model sees the denial reason, and no file is created. |
| S3 | `session.abort()` resolves only once the session is back to idle. The assistant message's `stopReason` is `aborted`. The same session can continue directly without reopening. |
| S4 | `steer()` and `followUp()` both return `"queued"`. The steer text shows up in **the next LLM call after the current tool batch finishes** (same run, call 1). followUp waits until the run would have stopped anyway and appears as a new run (call 4). Both semantics match the docs. |
| S5 | `SessionManager.create(cwd, sessionDir)` writes JSONL; after reattaching with `SessionManager.open(file, sessionDir)`, the history is in the model's context and the sessionId is the same. The host chooses sessionDir, so it can all live under `.uniqlaw/`. |
| S6 | The gateway received the correct token (per-session identity binding); native tools work too; the gate sees both kinds of tools. |
| S7 | Calling `session.setModel()` between two turns keeps the same session and history. On a cross-provider handoff, pi-ai automatically drops the other vendor's thinking blocks. |

## Capability (§5 shape)

```ts
{
  streaming: "token",
  interrupt: true,             // in-process abort(), no respawn
  inject: "steer",             // + followUp() for queue semantics
  resume: "native",            // pi SessionManager JSONL (host-chosen dir) — not core-managed
  modelSwitch: "live",
  permissionCallback: true,    // tool_call hook, async, fail-closed
  mcp: "per-session",          // pi.registerMcpServer() in an inline extension
  nativeTools: true,           // customTools / pi.registerTool
  attachments: ["image"],      // pi-ai image input (not exercised here)
  slashCommands: true,         // prompt() expands extension commands / prompt templates (not exercised)
}
```

## Suggested changes to the design doc

1. §5 provider-pi: change `resume` from the originally planned `core-managed` to `native`. pi's own SessionManager already handles persistence; you only need to specify sessionDir. Core-managed history may not be needed by any provider in the first version.
2. §5 / §10: provider-pi's permission gate can be implemented entirely by us (fail-closed); it has the most complete permission control of all providers.
3. §6: pi supports both `steer` and `followUp`, so all three queue mode options (queue / steer / interrupt) are native on pi.
4. Conclusion for M0 item 6: provider-pi must explicitly pass `resolveProjectTrust` and set `PI_CODING_AGENT_DIR`; add both to the adapter requirements and contract tests.
5. Test strategy: `fauxProvider` is a good **backend for testkit's provider-pi contract tests**, testing the whole harness deterministically in CI without spending quota. For other providers, it can also serve as a mock LLM for core tests.
