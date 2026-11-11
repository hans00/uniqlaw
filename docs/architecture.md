# UniQlaw Architecture Design (Draft v0.6)

> Goal: rebuild claudeclaw-v2 as a fully modular system. The underlying agent goes through a generic provider interface,
> cross-session communication is under our own control, and A2A is supported.
> Date: 2026-11-02 (v0.2: incorporates §13 decisions; v0.3: incorporates M0 test results, see `docs/spikes/M0-results.md`; v0.4: credentials layer, multi-instance isolation; v0.5: M1 implementation feedback; v0.6: M1.5–M4 implementation feedback, see §15). Items marked ⚠️ must be validated with a spike before implementation.

---

## 1. Goals and non-goals

**Goals**

1. **Everything is a plugin**: agent providers, chat platforms, schedulers and external protocols (A2A) are different kinds
   of the same plugin mechanism. Core only knows interfaces, not any concrete implementation.
2. **Generic provider interface**: Claude Code / Codex / OpenCode / Antigravity CLI / ACP-family agents
   / plain LLM APIs (OpenAI, Vertex, Anthropic API, OpenAI-compatible…) are all just adapters.
3. **Switching providers must not lose features**: every feature is either implemented by core or supported natively by the adapter.
   What an adapter cannot do, core fills in (polyfill); what cannot be filled in must be clearly flagged, never silently degraded (see §6).
4. **We own cross-session communication**: a self-built message bus, exposed to all agents through MCP (or native tools).
   No dependency on any provider-private mechanism (for example Claude's `SendMessage`).
5. **A2A native**: the bus data model follows A2A v1.0 (Message / Task / Part / contextId) directly,
   so external A2A is just a transport layer added around the bus.
6. **Full support for the three major clouds + direct APIs**: AWS Bedrock, Google Vertex AI, Azure (OpenAI / AI Foundry),
   and the Anthropic / OpenAI / Gemini direct APIs. API keys, Google ADC / service accounts, the AWS
   credential chain (profile / SSO / role) and Azure Entra ID must all be configurable (§10.1).
7. **Multiple claws on one machine**: multiple uniqlaw instances do not interfere with each other, including state, ports, tmux,
   provider config directories and login accounts (§11.2).
8. **The project only handles compatibility and support**: uniqlaw supports every authentication method a provider can use (including subscription account login).
   Which one to use, and whether it complies with that service's terms, is the user's responsibility; uniqlaw does not make policy decisions for the user.

**Non-goals (first version)**

- No live conversion of conversation history between providers (switching provider = new session, optionally with an injected summary).
- No sandbox of our own. The security boundary is left to the provider's permission mechanism, our tool gate, and the OS/container.

---

## 2. Overview

```
 Platforms (plugin)          Core                                   Providers (plugin)
┌──────────────┐   ┌────────────────────────────────────────┐   ┌──────────────────────┐
│ telegram     │──►│ Ingress ─► Router ─► Session Manager   │──►│ claude-sdk / -tmux   │
│ discord      │   │   (allowlist,        (per-session      │   │ codex   (app-server) │
│ slack        │◄──│    origin tag)        state machine,   │◄──│ opencode (HTTP/SSE)  │
│ line         │   │                       queue/steer)     │   │ acp / agy            │
│ web / cli    │   │ Egress ◄─ Output Pipeline              │   │ pi      (LLM APIs)   │
└──────────────┘   │   (NO_REPLY, react, segmenting)        │   └──────────┬───────────┘
                   │                                        │              │ tool calls
 Schedulers        │ Message Bus (A2A-shaped) ◄─────────────┼──────────────┘
┌──────────────┐   │   local peers / remote A2A peers       │   via MCP Gateway
│ cron         │──►│ Approval Broker   State Store          │   (per-session token)
│ heartbeat    │   └───────────────┬────────────────────────┘
└──────────────┘                   │
                         ┌─────────▼─────────┐
                         │ A2A transport     │◄──► remote A2A agents
                         │ (server + client) │
                         └───────────────────┘
```

There are two core principles: **core only knows normalized events and origin tags**, and **every agent-callable feature goes through the
MCP Gateway**. Together they decouple features from providers.

---

## 3. Plugin model

All plugins share the same shell:

```ts
interface PluginDef<K extends PluginKind, Cfg> {
  kind: K;                       // "provider" | "platform" | "scheduler" | "transport" | "tool"
  name: string;                  // "claude", "telegram", "cron", "a2a", ...
  configSchema: Schema<Cfg>;     // valibot/zod, validated at daemon startup
  create(ctx: PluginContext, cfg: Cfg): Promise<PluginInstance<K>>;
}

interface PluginContext {
  log: Logger;
  state: StateStore;             // namespaced KV + jsonl
  bus: BusClient;                // send/receive envelopes
  events: EventEmitter;          // core lifecycle events
}

interface PluginInstanceBase { start(): Promise<void>; stop(): Promise<void>; health(): Health; }
```

| kind | Responsibility | First-version implementations |
|---|---|---|
| `provider` | Runs agent turns, emits normalized events | claude, codex, opencode, acp, pi |
| `platform` | Sends/receives chat messages, reactions, attachments, interactive buttons | telegram, discord, slack, line, web |
| `scheduler` | Produces synthetic turns on a schedule | cron, heartbeat |
| `transport` | Connects the bus to the outside | a2a (server + client) |
| `tool` | Adds new tools to the MCP Gateway | bus, cron-admin, platform-send, react |

A plugin is an npm package (or workspace package) with `export default definePlugin({...})`.
Enable it in settings with `plugins: { "<name>": { enabled, ...cfg } }`.

---

## 4. Core concepts

| Concept | Description |
|---|---|
| **Agent Profile** | Named configuration: provider + model + system prompt parts + permissions + tool set. For example `main` (claude/opus), `cheap` (pi/gemini-flash), `coder` (codex). |
| **Channel** | A conversation endpoint on a platform (`telegram:<chatId>`, `discord:<channelId>`, `slack:<ch>:<ts>`). **Each DM is its own channel too** (`telegram:<userId>`, `discord:dm:<userId>`, `slack:dm:<userId>`, `line:<userId>`), instead of being collapsed into `global` as in v2 (§13 #10). |
| **Internal session** | A session not bound to a chat, whose name is not a key any platform can resolve: `heartbeat`, `cron:<job>`, `global`…. Created by a scheduler or the bus; nobody is watching it directly. To talk to a person it uses `notify` / `agent_trigger` (§8.5). |
| **Binding** | The channel → profile mapping (can be overridden per channel in settings). Within one daemon, different channels can run different providers. |
| **Session** | A long-lived conversation of one profile on one channel, mapped to the provider's session/thread id. A2A `contextId` = session id. |
| **Turn** | From one send into the agent until that turn ends. A2A `taskId` ≈ turn id. |
| **Origin** | Every input carries a source tag (see below). **Where output goes is decided only by origin, never by the text the provider emits.** |

```ts
type Origin =
  | { kind: "human";     platform: string; channel: string; sender: Sender; replyTo: MsgRef }
  | { kind: "peer";      from: SessionRef; hop: number; replyMode: "to-sender" | "to-own-human" }
  | { kind: "scheduler"; job: string; deliverTo?: Target }
  | { kind: "a2a";       remote: AgentRef; taskId: string; hop: number }
  | { kind: "system";    reason: "resume" | "compact" | "background" };
```

v2 suppressed platform output by detecting text wrappers such as `<cross-session-message>`. In uniqlaw, core
knows the origin when it sends the turn, so the decision is entirely in core's hands.

---

## 5. Provider interface

```ts
interface ProviderCapabilities {
  streaming: "token" | "segment" | "final";  // output granularity
  interrupt: boolean;                        // can abort an in-progress turn
  steer: boolean;                            // mid-turn insertion (inserted after the current tool call)
  // queuing at turn boundaries is always done by core (a provider's native queue is only an optional optimization), so it is not a capability
  resume: "native" | "core-managed";         // who keeps the conversation history
  denyEndsTurn: boolean;                     // whether denying a permission ends the whole turn (claude-tmux=true)
  modelSwitch: "live" | "spawn" | false;
  permissionCallback: boolean;               // asks us when a tool needs approval
  mcp: "per-session" | "per-process" | false; // per-session only counts if it passes the "cross-session MCP isolation" contract test
  nativeTools: boolean;                      // can register in-process tools directly (no MCP needed)
  attachments: ("image" | "file" | "audio")[];
  slashCommands: boolean;                    // provider has its own /command system
}

interface AgentProvider {
  readonly name: string;
  capabilities(profile: Profile): ProviderCapabilities;
  open(spec: SessionSpec): Promise<AgentSession>;   // create new or resume
}

interface SessionSpec {
  sessionId: string;              // uniqlaw's id
  providerSessionId?: string;     // used on resume
  cwd: string;
  profile: Profile;
  systemPrompt: SystemPromptParts;
  mcp: { url: string; token: string };         // MCP Gateway endpoint (per-session token)
  nativeTools?: ToolDef[];                     // passed directly when nativeTools=true
  history?: NormalizedMessage[];               // passed when resume=core-managed
}

interface AgentSession {
  // M1: detach?() — on daemon stop, let go without killing the provider process (claude-tmux keeps tmux; open() reattaches after restart)
  send(input: TurnInput): Promise<void>;       // starts a new turn when idle
  steer?(input: TurnInput): Promise<void>;     // only when steer=true; in the race where the turn just ended, the adapter falls back to send itself
  interrupt?(): Promise<void>;
  setModel?(model: string): Promise<void>;
  respondPermission?(id: string, decision: PermissionDecision): Promise<void>;
  events: AsyncIterable<AgentEvent>;
  close(): Promise<void>;
}

type AgentEvent =
  | { type: "session"; providerSessionId: string }
  | { type: "turn_start"; turnId: string }
  | { type: "text"; delta?: string; final?: string; segmentId: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary?: string }
  | { type: "permission_request"; id: string; tool: string; input: unknown; title: string }
  | { type: "input_request"; id: string; schema: unknown; title: string }   // ACP elicitation, MCP elicitation
  | { type: "turn_end"; turnId: string; reason: "done" | "interrupted" | "error"; usage?: Usage }
  | { type: "unsolicited_turn" }                 // agent wakes up on its own (background task, wakeup)
  | { type: "error"; error: string; fatal: boolean };
```

### 5.1 Adapter overview (based on the 2026-11 survey)

| adapter | Control interface | Package | Notes (M0 tests) |
|---|---|---|---|
| **claude-sdk** | Claude Agent SDK `query()`, streaming-input mode | `@anthropic-ai/claude-agent-sdk` 0.3.x | See §5.2 |
| **claude-tmux** | The real `claude` TUI running in tmux (ported from v2) | None (tmux + jsonl tail + pane detection) | See §5.2 |
| **codex** | `codex app-server` (stdio JSON-RPC) | Speaks the protocol directly; types generated with `codex app-server generate-ts` (`@openai/codex-sdk` lacks steer/approval) | `turn/steer {threadId, expectedTurnId, input}` is a real steer (returns `-32600` when idle → use `turn/start` instead); permissions are server→client requests (`item/*/requestApproval`); MCP goes in `thread/start.config.mcp_servers`, per-session, and needs `default_tools_approval_mode` set; model via `turn/start.model` (carried over to later turns). **`memories` must be disabled** (memory shared across threads); `agent_message_board` / `wake_on_agent_messages` must also be force-disabled once they ship. |
| **opencode** | `opencode serve` HTTP + SSE `/event` | `@opencode-ai/sdk` 1.19 | `prompt_async` while busy = steer (picked up at the next step boundary); `permission.asked` + `/permission/:id/reply`; model specified per message; turn end is `session.idle`, but the duplicate idle after an abort must be dropped. **MCP is shared across the whole instance → one serve per session**. The bash tool's cwd is the git worktree root, not the `directory` parameter. |
| **acp** (generic) | ACP stdio JSON-RPC | `@agentclientprotocol/sdk` 2.2 | Tested against `opencode acp`: passes. The protocol has no steer, but the behavior of concurrent `session/prompt` is up to the agent (opencode steers) → default `steer=false`, upgraded only after the contract test passes. Model via `session/set_config_option`. `session/load` **replays history**, which the adapter must suppress. **The protocol says MCP is per-session, but opencode's implementation shares it per process, which leaks identity → always one process per session**. Gemini CLI has been replaced by Antigravity CLI and is **not a support target** (Google's coding agent always goes through the agy adapter). |
| **agy** (Antigravity CLI, official Google, replaces Gemini CLI) | `agy --input-format stream-json --output-format stream-json -p=` (official headless) | None | One process = one conversation. No control channel on stdin → interrupt = SIGINT + reopen with `--conversation`, model switch = reopen, mid-turn messages can only be queued. **No permission callback**: headless auto-denies by default; the only option is pre-allowing via `--settings permissions.allow` (rules need the full command or `*`). MCP can only be configured by placing `.agents/mcp_config.json` in the cwd → use a stdio shim (see §8.3). `--remote-control` not yet investigated; it might provide a permission callback. |
| **pi** (self-built harness) | `@earendil-works/pi-coding-agent` SDK (`createAgentSession()`, in-process) | 1.4.0 (scope moved from `@mariozechner` to `@earendil-works`) | All mechanisms verified (with the faux provider; real models pending credentials): the `tool_call` hook can wait asynchronously for approval and blocks by default on error, and built-in / native / MCP tools all pass through it; `steer()` / `followUp()` / `abort()` / `setModel()`; `registerMcpServer()` per-session; native tools; we choose the session JSONL directory. **`resolveProjectTrust` must be passed** (without it, protected resources in `.pi/` are loaded by default), and **`PI_CODING_AGENT_DIR` must be set** for isolation (the MCP OAuth store ignores the passed-in agentDir). |

Measured capability values per adapter (§5 format):

| adapter | streaming | interrupt | steer | resume | denyEndsTurn | modelSwitch | permissionCallback | mcp | nativeTools | slashCommands |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sdk | token | ✅ | ✅ | native | ❌ | live | ✅ | per-session | ✅ | ✅ |
| claude-tmux | segment | ✅ | ✅ | native | ✅ | live (`/model` + dialog) | ✅ (pane detection) | per-session (per-process) | ❌ | ✅ |
| codex | token | ✅ | ✅ | native | ❌ | live (per turn) | ✅ | per-session | ❓ | ❌ |
| opencode | token | ✅ | ✅ | native | ❌ | live (per message) | ✅ | per-process | ❌ | ✅ |
| acp (conservative default) | token | ✅ | ❌ (upgraded after testing) | native (loadSession) | ❌ | live (if a model config option exists) | ✅ | per-process | ❌ | ✅ |
| agy | token | ✅ (SIGINT + reopen, slower) | ❌ | native | n/a | spawn | ❌ | per-process (shim) | ❌ | ✅ |
| pi | token | ✅ | ✅ | native | ❌ | live | ✅ | per-session | ✅ | ✅ |

No adapter currently needs `resume: "core-managed"` (pi stores its own JSONL); it is reserved for a future minimal adapter over a plain LLM API.

### 5.2 The two Claude adapters: `claude-sdk` and `claude-tmux`

Both are built, sharing a `claude-common` package: system prompt assembly, translating permission policy into CLI flags,
jsonl parser, session id management, disabling `ListAgents` / `SendMessage`.

| Capability | claude-sdk | claude-tmux |
|---|---|---|
| streaming | `token` (`--include-partial-messages`) | `segment` (jsonl only flushes at tool / end_turn boundaries) |
| interrupt | `q.interrupt()` | `send-keys Escape` |
| steer | ✅ each message can set `priority`: `next` = steer, `later` = queue after the turn, `now` = interrupt and run immediately | ✅ pasting while busy = `queued_command`, delivered mid-turn (v2's `native` mode was always steer) |
| Permission denial | Only that tool call fails; the turn continues | **The whole turn ends** (`denyEndsTurn`) |
| resume | native (`resume: id`) | native (`--resume <id>`) |
| modelSwitch | `live` (`setModel`) | `live` (type `/model`; a model-switch dialog may appear, handled by pane detection) |
| permissionCallback | `canUseTool` | Pane detection of the permission dialog → adapter converts it to a `permission_request` event; the reply is sent as keystrokes |
| mcp (bus tools) | In-process SDK MCP server | `--mcp-config` pointing at the MCP Gateway URL + per-session token |
| slashCommands | ✅ just send it as the prompt (tested: all 13 plugins, 134 skills, 188 commands loaded; user hooks fire) | Full (native to the TUI, including plugin commands) |
| Specific overhead | No TUI | init-watch, detection of login / survey / folder-trust / model-switch dialogs, all encapsulated in the adapter; v2's busy regex no longer matches the new spinner and needs updating |

**Session interop (M0 tested ✅)**: a session opened in tmux can be picked up with SDK `resume`, and vice versa,
with full history. So which adapter Claude uses is just a profile setting. Note: the jsonl must be located by id via
`~/.claude/projects/*/<id>.jsonl`, not derived from the cwd (resuming in a different cwd keeps appending to the original file);
the jsonl can be very large (it contains `api-request-blob`), so the tail must not read from the beginning.

**Common rules for the Claude adapters (M0 findings)**:
- **Always set `permissionMode` explicitly**. The user's global settings may have `defaultMode: "auto"`; if unset, the classifier approves directly and our approval is skipped.
- **Bus tools get lazy-loaded** (hidden behind ToolSearch) → set them to always-load, or list the tool names directly in the system prompt.
- **Native messaging socket (unresolved risk)**: `disallowedTools` removes `ListAgents` / `SendMessage`, but interactive mode (tmux) and SDK mode still open `messaging_socket_path` (`-p` mode does not). M1 testing: the binary contains `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`; setting them changes nothing in `-p` init, interactive mode not verified; no public off switch found (`disableMessagingBeyondOwnAgents` is an internal API). **Consequence**: other Claude sessions on the same machine can send messages into a uniqlaw session; that turn has no origin, so core treats it as background output and sends it, per `backgroundNotify`, to the last chat counterpart (which could put external content into the user's chat). **Mitigation direction** (to be verified in M1.5): a separate `CLAUDE_CONFIG_DIR` per instance (peer discovery may be scoped to the config directory); or send unsolicited turns of unknown origin to the operator only.
- **User hooks carry context across sessions** (for example claude-mem injects previous content in the same cwd) → profile options: a separate cwd per channel, or `settingSources` without `user`.
- **Authentication**: both adapters support every method Claude Code can use: claude.ai subscription login (OAuth inside `CLAUDE_CONFIG_DIR`), `ANTHROPIC_API_KEY`, Bedrock (`CLAUDE_CODE_USE_BEDROCK`), Vertex (`CLAUDE_CODE_USE_VERTEX`), Azure AI Foundry (`CLAUDE_CODE_USE_FOUNDRY`). Which one to use is the user's decision and responsibility (goal 8); the README only needs links to the relevant terms of service.

**Disable provider-native cross-session tools (mandatory rule)**: every adapter must turn off the provider's built-in cross-session tools (claude → `disallowedTools: ["ListAgents","SendMessage"]` plus disabling the messaging socket; codex → disable `memories`, and also the future `agent_message_board` / `wake_on_agent_messages`). Otherwise agents bypass the bus and produce turns with no origin, and the routing and output suppression in §8.4 break (the old v2 problem of sniffing `<cross-session-message>` comes back). The contract tests must verify this.

**Decision on the self-built harness: build on the `pi-coding-agent` SDK, not from scratch on `pi-agent-core`.**
pi-coding-agent already has file/bash tools, skills, MCP, session persistence, compaction and
slash commands. We only need to add:
(a) wiring the `tool_call` hook to the Approval Broker,
(b) system prompt assembly,
(c) registering bus tools as native tools.
This is the biggest effort lever in the whole project and saves several thousand lines of harness code.

---

## 6. Capability polyfill (the core of not losing features when switching providers)

| Missing capability | How core handles it | User-visible difference |
|---|---|---|
| `steer = false` (agy, unverified ACP agents) | Only `queue` mode: debounce + merge + cap/dropPolicy | `steer` mode is unavailable; configuring it is an error (not silently changed) |
| `steer = true` (all others) | Choose `steer` (inserted after the current tool call) or `queue` (core queues until the turn ends) | v2's `native` mode is renamed `steer` |
| Slow `interrupt` (agy: SIGINT + reopen) | Offered as usual; UI shows "interrupting" | Interrupts take a bit longer |
| `interrupt = false` | `interrupt` mode unavailable; `/stop` replies "this provider does not support interrupt" | Explicit error |
| `permissionCallback = false` (agy) | Generate a pre-allow list from PermissionPolicy; denied actions are reported to the operator afterwards | No per-call approval; warning at settings validation |
| `denyEndsTurn = true` (claude-tmux) | After a denial, core automatically adds a turn telling the agent "that operation was denied, use another approach" | The reply arrives in two parts |
| `resume = "core-managed"` | Core keeps normalized history and hands it to the adapter on open | None |
| `resume` replays history (ACP `session/load`) | Adapter suppresses all events until load completes | None |
| `modelSwitch = "spawn"` (agy) | The model router only takes effect when a session opens; live switching becomes "reopen session + resume" | Switching drops the prompt cache |
| `mcp = "per-process"` (opencode, acp, agy) | One provider process per session, so the token is bound to an identity | Higher resource usage |
| `mcp = false` and `nativeTools = false` | Fall back to a text protocol: markers like `[react:🌸]`, `[send:target]…`, parsed by the Output Pipeline | Feature kept, lower reliability |
| `slashCommands = false` (codex) | Core implements `/model /stop /new /status` itself; provider commands are not registered on platforms | Only provider-private commands are missing |

**M1 implementation notes:**
- `turn_end.error` can carry a typed code: `rate_limit` (retryable), `usage_limit`, `stall`, `auth`, `crash`; core later uses this for consistent automatic retries across providers.
- Credentials are converted to provider-specific env / config by the **adapter**; the `spec.env` core provides contains only basic environment variables and **never** pre-loads credentials.
- For TUI-based providers, `permission_request.input` is the raw dialog text; core strips separators and prompts with `cleanDialogText()` before display. The UI must not rely on structured input.
- While a permission dialog is open, the adapter buffers steer messages and sends them after the dialog closes.
- `queue.mode` values are `queue | steer | interrupt` (v2's `native` migrates to `steer`).

**Rule:** at settings validation, check every requested feature against the profile's capabilities.
If it cannot be done, **fail to start and explain why**, rather than silently degrading at runtime.

---

## 7. v2 feature mapping

| v2 feature | Where it lives in uniqlaw | How it becomes provider-independent |
|---|---|---|
| Multiple platforms (TG/DC/Slack/LINE) | platform plugin | Unchanged, interface extracted |
| DMs collapsed into global, per-channel/thread sessions | Platform provides the key, core Router | Groups / channels / threads keep v2's rules; **DMs become one session per person** (§13 #10) |
| queue / native / interrupt modes | core Session Manager | Becomes queue / steer / interrupt (native was really steer), per the §6 polyfill; migration maps `native` → `steer` |
| Permission approval (inline buttons) | core Approval Broker | Source unified as the `permission_request` event, or pi's `tool_call` hook; previously tmux pane detection, no longer needed |
| login / survey / model-switch dialogs | Inside the claude-tmux adapter | Exists only inside the tmux adapter; to core it is uniformly `permission_request` or `error{auth}` → notify the operator |
| `NO_REPLY` / `HEARTBEAT_OK` silence | core Output Pipeline | The same post-processing on every adapter's final text (v2's `silent.ts` moved over as is) |
| `[react:🌸]` reactions | Primarily the `react` MCP tool, text marker as fallback | |
| Tool progress display (tool-display) | core, consumes `tool_start/end` | |
| messageStream replace/keep/off | core Egress + platform capabilities | Whether live editing is possible depends on `streaming` granularity |
| Cron (.md frontmatter) | scheduler plugin + `cron-admin` MCP tool | Also resolves the v2 TODO "cron MCP tools" |
| Heartbeat + quiet hours | scheduler plugin | origin=scheduler, results go through the Output Pipeline |
| Model routing (agentic modes + hysteresis) | core, calls `setModel` | Per the `modelSwitch` polyfill |
| backgroundNotify (output when the agent wakes on its own) | core, consumes `unsolicited_turn` | |
| Cross-session send / trigger / SendMessage | core Message Bus + MCP tools | §8 |
| Attachment download + prompt prefix | core (download) + adapter (passes natively if it has the image capability) | |
| Registering slash commands on platforms | core commands + provider commands listed too when it has `slashCommands` | |
| Idle session cleanup | core | Close the session, keep the id, resume next time |
| System prompt assembly (IDENTITY/USER/SOUL, dir scope, NO_REPLY rules) | core `SystemPromptParts` → adapter decides how to inject (append flag / system message / AGENTS.md) | |
| Web dashboard + HTTP API | `web` platform plugin + core API | |
| statusline / state.json | core | |
| v1→v2 migrate | Agent follows `docs/MIGRATE.md` (see §11.1) | Full v2 → uniqlaw migration |

---

## 8. Cross-session communication: Message Bus

### 8.1 Decision: build our own bus, do not use provider-native mechanisms

- Claude's `SendMessage` and the subagents of Codex/OpenCode are each **private and not interoperable**. Any
  feature that depends on one of them disappears when switching providers, which violates goal 3.
- Every coding agent supports MCP, and pi can register native tools directly → **one set of bus tools covers every
  provider**.
- Only a self-built bus allows uniform origin routing, hop limits, audit logs, and external A2A.
- Provider-native subagents (for example Claude's Task tool) can still be used. They are **internal** to a session,
  not cross-session communication, and the bus does not interfere.

### 8.2 Envelope (A2A-shaped)

```ts
interface Envelope {
  id: string;
  contextId: string;          // target session (A2A contextId)
  taskId?: string;            // corresponding turn (A2A taskId)
  from: AgentRef;             // local:<sessionKey> | a2a:<agentCardUrl>
  to: AgentRef;
  parts: Part[];              // A2A Part: text | file | data
  mode: "ask" | "trigger" | "notify";
  hop: number;                // +1 per forward; rejected once it exceeds maxHops
  metadata?: Record<string, unknown>;
}
```

### 8.3 Tools for agents (MCP Gateway)

| Tool | Semantics | v2 equivalent |
|---|---|---|
| `agents_list()` | Lists local sessions and configured remote A2A agents (name, profile, status, capabilities) | `ListAgents` |
| `agent_ask(to, message, wait?)` | The target runs a turn and **the reply comes back to you**; the target's output does not go to a platform | Native `SendMessage` |
| `agent_trigger(to, prompt)` | The target runs a turn and **replies to its own human** | `/api/trigger` |
| `notify(target, text)` | Sends text you wrote directly to a human via the platform API, and writes it to the pending-input queue (state.db) of the session that owns that target, so it knows on its next run | `/api/send` |
| `task_status(taskId)` / `task_cancel(taskId)` | Query or cancel work sent out with `agent_ask` (status includes elapsed time and live progress; see below) | — |

How `agent_ask` replies:
- `wait=true`: the tool blocks until the target's turn ends, then returns the result. Suitable for short tasks; has a timeout.
- `wait=false`: returns a `taskId` immediately. When the target finishes, core opens an
  `origin=peer` turn in your session and delivers the result; if you are currently running, it is handled per the steer capability.
  This does not depend on any provider's "background notification" feature.

`task_status(taskId)` (only the asker and the answering session can see a task) returns `state`, `result` and
`elapsedSec` (until now while open, until it finished otherwise). While the task is still open and its session is local,
it also returns `progress`:
- `phase: "running"`: the session's current turn is answering it. `turnElapsedSec`, `latestText` (the assistant text
  being streamed right now, else the last finished one; at most 1500 chars, tail kept) and `recent` (the turn's last 10
  activity lines, `text: …` / `tool: <name>`, one line each, at most 200 chars; tool inputs are never shown) come with it.
  All of it counts from when this task's ask joined the turn: an ask steered into a running turn sees nothing from
  before it arrived (`turnElapsedSec` also starts then). After that the turn is one conversation, so its texts can
  still be about another asker's work.
- `phase: "queued"`, `queuePosition`: it waits for the session's current turn to end.

Progress lives in memory with the turn: it is not persisted, and a reload loses it until the next turn starts.

**An `agent_ask` (or `worker_start` with a task) that reaches a session mid-turn** follows `queue.mode`, like a human
message would. It never interrupts unless `queue.mode` is `interrupt`:
- `queue` (default): it waits in the queue (`task_status` → `queued`) and runs as its own turn once the current one ends.
  Several inputs that piled up meanwhile are merged into that one turn, and each ask gets the turn's whole answer.
- `steer` (when the provider can steer; claude-tmux types it into the pane, held while a permission dialog is open): it
  joins the running turn. That turn's final answer completes both tasks, so each asker gets the same combined reply.
- `interrupt`: the current turn is stopped (a task it was answering fails with `(interrupted) …` plus any text it had), then the queue runs.
- A worker a human holds (`/attach`, terminal takeover) refuses the ask instead.

**Identity binding:** the MCP Gateway URL carries a per-session token (`/mcp/<token>`). Tools do not accept
"who am I" style parameters; the caller's identity is determined by the token, so an agent cannot impersonate another session.
Providers that can only configure MCP through a file and do not expand environment variables (agy) use a **stdio shim** instead: the config file points to
`uniqlaw mcp-shim`, and the shim takes its identity from the inherited environment variable `UNIQLAW_TOKEN` and forwards to the Gateway.
The contract tests must include "two sessions with MCP attached at the same time, each able to see and call only with its own token".

**Loop prevention:** a `hop` limit (`bus.maxHops`, default 4), plus rate limiting of back-and-forth between the same pair of sessions over a short period.
- A turn's hop is the highest hop among its peer / A2A origins; a human message in the turn makes it 0 (a new chain).
- An async `agent_ask` result (wait=false, or `worker_start` with a task) re-enters the asker at the asker's *own* hop
  from when it asked, not the callee's: the answer closes that step instead of deepening the chain, so a chat can work
  with its worker for many rounds. Nested asks (A asks B asks A …) still deepen the hop and stop at `maxHops`.
- Result → ask → result rounds are bounded separately: each result carries `rounds` (results in a row since the last
  human message), and an async ask that would bring back more than `bus.maxRounds` (default 20) is refused.
- Fan-out is bounded too, since rounds and hops only bound depth (a turn that fires two asks on every result would
  otherwise reach 2^maxRounds turns):
  - `bus.maxPending` (default 8): async `agent_ask` / `agent_trigger` / `worker_start` tasks one session may have
    outstanding; the next one is refused until a result comes back. Waiting asks don't count.
  - `bus.maxChainTasks` (default 50): every delegation call (waiting or not) is charged to a chain, across all the
    sessions it reaches. A human message starts a chain; peer inputs and results carry it; a turn with neither (cron,
    heartbeat, A2A) starts its own. Once used up, further calls in that chain are refused.
  - The counters live in memory: a daemon restart resets them.
The system prompt of an `origin=peer` turn injects "reply once and stop".

### 8.4 Output routing (decided by core based on origin)

| Turn origin | Text output goes to | Permission requests go to |
|---|---|---|
| human | That channel (as a reply to the triggering message) | That channel's trusted operator |
| peer / ask | Back to the asker (as the task result) | The human channel at the origin of the chain, otherwise the operator |
| peer / trigger | The triggered session's own channel | Same as above |
| scheduler | The job / heartbeat `replyTo`; `"none"` = not sent (the agent sends with tools itself); if unset, follows `backgroundNotify` | operator |
| a2a | A2A task artifact | operator (task stays WORKING; FAILED if denied) |
| Merged turn (multiple origins) | If it includes a human, send to that human channel; the other origins receive the task result | — |

### 8.5 Session / profile / model for internal sessions and schedules

- **Session kinds**: every `agents_list` entry has a `kind`: `chat` (its name is the notify / trigger target), `internal` (no chat), `a2a` (serving remote A2A calls), `remote` (a remote A2A agent). The system prompt of an internal session gets an extra section: you have no chat of your own; to talk to a person use `notify` / `agent_trigger`; to ask another session use `agent_ask`.
- **What the bus can reach**: existing sessions (chat, internal, A2A), and chat keys a platform can resolve (created on first trigger). **Misspelled internal names are not created**, so an agent typo does not open an extra session.
- **Which session a schedule runs in**: heartbeat runs in its own internal session `heartbeat` by default; a cron job file without `target` runs in `cron:<job>`; `cron_save` defaults to the caller itself, and `target: "own"` means `cron:<name>`. Any chat key can also be specified (for example running in a DM gives it that conversation's context).
- **profile** (heartbeat's `profile`, job frontmatter's `profile:`): pins that session to a profile (provider + model + permissions), stored in the `state.db` kv (`session-profile:<key>`) and kept across restarts. Changing the profile while the session is idle reopens it; if busy, it waits until the next close. It can also be bound directly in `bindings.channels` (`"heartbeat": "cheap"`) with the same effect. Precedence: A2A-specified > schedule-pinned > `bindings.channels` > `bindings.default`.
- **model** (heartbeat's `model`, job's `model:`): applies only to that one scheduled turn. Requires the provider to support live model switching (`modelSwitch: "live"`); before the next turn without a model starts, the original model is restored (if the profile has no model and uses only the provider default, it cannot be restored and a warning is logged). For providers without live model switching (agy, some ACP), use `profile` instead.
- **Cross-session**: every session (including internal ones) has its own MCP Gateway token, so heartbeat / cron can `agent_ask` other sessions, `agent_trigger` a DM / group session to talk to its person with its own context, or `notify` any chat target directly.

### 8.6 Workers: directing other coding agents on the same machine

Any session can use `worker_start` to open a coding agent (Claude Code, Codex, OpenCode…, i.e. some profile) in a given directory and hand work to it. After that it communicates with it through ordinary `agent_ask`. A human can take it over from a chat or a terminal.

- **Identity**: a worker is the session key `worker:<name>` (`kind: "worker"` in `agents_list`, with `cwd`, `owner`, `heldBy`). On creation it is recorded in kv: `worker-meta:<key>`, `session-cwd:<key>`, `session-profile:<key>`. **The working directory is fixed after creation**: claude-tmux uses the cwd to find the jsonl, codex uses the cwd to compute the sandbox, and the cwd cannot change on resume. To change directory, start a new worker.
- **Working directory**: `SessionSpec.cwd` already existed and every provider honors it; core just always passed the project directory before. It now uses `host.cwdFor(key)`, falling back to the project directory when unset.
- **Limits** (`settings.workers`): `roots` (allowed directories and their subdirectories, compared by realpath with `..` and symlinks resolved first; empty array = project directory only), `profiles` (allowed profiles, empty array = all), `max` (default 8). Sessions that can call `worker_start` get an extra `workers` section in their system prompt: it lists the allowed directories and profiles, and states "dispatching to directories outside your own scope is allowed; UniQlaw does the checking". Testing showed that without this section the main agent refuses to dispatch because of its own dir-scope prompt.
- **Worker system prompt**: IDENTITY / USER / SOUL are not loaded (that is the chat assistant's persona); instead a `worker-session` section is added: which directory you are in, who assigned the task, that replies go back to them, and that you should finish by reporting what you changed and how you verified it. dir-scope is based on the worker's cwd. The target directory's own CLAUDE.md / AGENTS.md are loaded by the provider as usual.
- **Reporting**: `worker_start` with `task` follows `agent_ask` semantics, default `wait:false`; when the worker finishes, the result is delivered to the dispatching session as a new message. The worker's permission requests go, per §8.4, to the human at the top of the delegation chain. The worker's background output (for example turns triggered by a human typing in the terminal) **does not** go through backgroundNotify: if a chat is attached it goes to that chat, otherwise it stays only in the transcript.
- **Human takeover**, two kinds:
  - **Chat** (works with every provider): a trusted user types `/attach <worker>` in a chat; from then on that chat's messages go to the worker, and replies and permission requests come back there; `/stop`, `/new`, `/model`, `/status` all act on the worker. `/detach` ends the takeover. `/attach` with no argument lists all workers. The binding is stored in kv (`chat-attach:<chatKey>`) and survives restarts.
  - **Terminal** (`uniqlaw attach <worker>`; the provider must implement `attachCommand`):
    - claude-tmux is a **live** takeover: it runs `tmux -L uniqlaw-<instanceId> attach-session -t uq-…` directly; the agent keeps running and the daemon keeps watching.
    - claude-sdk / codex is a **handoff**: core first closes the session (keeping the provider session id), and the CLI runs `claude --resume <id>` / `codex resume <id>` in the worker directory. When the human leaves that CLI, control returns to the daemon, and the next task resumes the same conversation, including what the human did in the CLI. Only supported for the default login or a `provider-login` home (which passes `CLAUDE_CONFIG_DIR` / `CODEX_HOME`); API-key credentials are not supported because the secret is not handed out.
    - Other providers have no terminal takeover; use chat attach. Chat sessions can only be attached live; handoff is limited to workers.
    - Verification status (2026-11-08, `packages/daemon/test/workers-e2e.test.ts`, real Claude): the claude-tmux live attach target is indeed that worker's tmux session, and the pane is in the worker directory. During a claude-sdk handoff, what the human asked via `claude --resume <id> -p …` is remembered by the worker after the daemon takes it back. **codex handoff has only been tested with a fake**: whether the same still-running app-server can, after `thread/unsubscribe` and then `thread/resume`, read content another process wrote into the rollout has not been verified.
  - Takeover state is stored in kv (`hold:<key>`). On daemon restart, sessions still in handoff are not restored; schedules, async results and `worker_start` without a task also do not reopen it during a takeover (async results go into the worker's unread messages instead). If the terminal was closed without a proper handback, release it with `uniqlaw release <worker>`.
  - During a takeover the worker is in the **held** state: further `agent_ask` / `agent_trigger` from the owner get an error saying "someone is operating it, wait until they leave", so instructions are not inserted into the human's conversation. When the human leaves, the owner gets an unread notification: "someone operated the worker and may have changed files or given new instructions".
- **Stopping**: `worker_stop(name)` shuts down the agent process but keeps the conversation; a `worker_start` with the same name continues it. `forget: true` deletes the record and the conversation. Files the worker changed are never touched.
- **CLI / API**: `uniqlaw workers`, `uniqlaw worker start|stop`, `uniqlaw attach`, `uniqlaw release`; `GET/POST /api/workers`, `POST /api/takeover`, `POST /api/release`.

### 8.7 Memory and dreaming

UniQlaw has its own long-term memory so it survives provider changes (Claude Code's auto-memory only exists for Claude; Codex's memories are disabled, §5). Modelled on OpenClaw's `memory-core` (studied 2026-11-09); one memory per instance, shared by all sessions.

- **Files** (`<project>/memory/`, `settings.memory.dir`):
  - `MEMORY.md`: curated long-term memory. Injected into the system prompt of chat and internal sessions (not workers, not `dream`), capped at `memory.maxInjectBytes` (24 KB; the file itself is never truncated). The prompt is built when a session opens, so a long-lived session sees a rewrite only after `/new` or idle-close; the dreaming sweep leaves every open chat a pending note saying MEMORY.md changed.
  - `YYYY-MM-DD.md`: daily notes, append-only, one entry per `memory_write` (`- HH:MM text <!-- m:<id> -->`). Searched, never injected.
  - `DREAMS.md`: dream diary for humans. Never indexed, never promoted.
  - Any other `*.md` (topic files, `imports/…`) is indexed for search. `.history/` keeps pre-images of `MEMORY.md`.
- **Tools** (MCP gateway, every provider): `memory_write(text, importance?)` appends to today's note (identical text the same day is not repeated; the `dream` session can't write); `memory_search(query)`; `memory_get(path, from?, lines?)` (cannot leave the memory directory).
- **Search**: SQLite FTS5 with the `trigram` tokenizer in `state.db`, so substring matching works for Chinese/Japanese; queries shorter than 3 characters fall back to `LIKE`. Ranked by bm25 (normalised within the result set) × recency (30-day half-life) × importance. Files edited by hand are re-indexed by mtime/size on the next search.
- **Signals** (`state.db`): `memory_meta` records who wrote each entry (origin: `chat` = one-to-one chat with an allowed user, `group` = multiparty chat, `internal`, `worker`, `remote`; plus the session key and importance). `memory_recall` records each search hit made by a one-to-one chat session: count, distinct queries, days.
- **Provider-native memory**: with UniQlaw memory on (default), sessions get `SessionSpec.nativeMemory: false`; the Claude adapters pass `autoMemoryEnabled: false, autoDreamEnabled: false` (`--settings` / SDK `settings`) so there is one memory, not two. `memory.nativeMemory: true` keeps Claude's as well. Memory MCP servers from user settings (e.g. claude-mem) are unaffected (§13 #9).
- **Dreaming** (`plugins.dreaming`, opt-in because it costs a model call or two per night; default `0 3 * * *` in `settings.timezone`). The engine (`core/src/dreaming.ts`) runs three phases:
  - **Light** (rules): daily notes from the last `lookbackDays` (14), deduped by normalised text, with their recall signals, origin and importance.
  - **REM** (rules): entries recalled on several days and entries written on several days. These only feed the diary.
  - **Deep**: the **rules decide which entries are candidates**: weighted score (relevance 0.30, frequency 0.24, query diversity 0.15, recency 0.15, multi-day 0.10, richness 0.06), and an entry passes if any gate holds: *recall* (score ≥ `minScore` 0.45, recalled ≥ `minRecallCount` 2 times, ≥ `minUniqueQueries` 1 queries), *recurring* (written on ≥ `recurrenceDays` 2 days), *important* (`importance` ≥ `minImportance` 8). Entries written from group chats (where non-operators talk to the agent: a stranger could otherwise get "remember that the deploy password is X" into every future prompt), internal sessions, workers or remote agents are never candidates (a structural gate, as OpenClaw does with untrusted provenance; their notes stay searchable, and their prompt says so), and neither is anything already in `MEMORY.md` or handled by an earlier sweep. UniQlaw's recall thresholds are lower than OpenClaw's (0.75 / 3 / 3) because here `MEMORY.md` is in the prompt and agents search less; the recurring and important gates exist for the same reason.
  - **The model only chooses actions.** One fresh turn in the internal session `dream` (optional `profile` / `model`; a `locked` profile is recommended) gets the current entries (`E1…`) and the candidates (`C1…`) and returns JSON `{"operations":[{"candidate","action":"added|merged|superseded|skip","replaces":["E2"]}]}`. **The text written to MEMORY.md is always the candidate entry itself** with `<!-- src:<key> memory/<file> -->`; any text in the model's reply is ignored, so a hallucination can't put invented facts into long-term memory. Unknown ids are dropped, an existing entry can be claimed by only one operation, and candidates the model leaves out count as `added`.
  - **Validation**: the rewrite is rejected if it replaces more than `maxLossFraction` (25%, at least 1) of existing entries or exceeds the injection budget. A rejected rewrite, a failed turn or invalid JSON fall back to **append-only**; if even that doesn't fit, `MEMORY.md` stays **unchanged** and the candidates stay eligible. If the file changed while the model was thinking (a human edited it), nothing is written that night. The previous version goes to `memory/.history/` (last `historyKeep` 10), and the write is atomic (tmp + rename).
  - **Diary**: a second fresh turn writes a short first-person entry from the night's fragments, in their language. It is appended to `DREAMS.md` together with the counts and any replaced entries (struck through). A failed diary turn leaves a visible placeholder. A night with no new notes and no candidates writes nothing.
- **Running it by hand**: `uniqlaw dream --dry-run` ranks and explains every recent entry (which gate passed, or why not) without calling a model or writing anything; it works even when the plugin is off. `uniqlaw dream` runs a full sweep. `POST /api/dream {dryRun}`.
- **Plumbing**: `ChannelManager.complete()` runs one turn in an internal session and returns its final reply (scheduler origin with `taskId`, silent, failures go back to the caller rather than to an operator chat). `SchedulerApi` exposes `complete`, `memory` and `noteToOpenChats` to scheduler plugins.
- **Verification** (2026-11-09, real Claude haiku): `memory-e2e.test.ts` shows the agent saving a fact with `memory_write` unprompted and, after `/new`, answering from `memory_search` (claude-tmux and claude-sdk). That Claude Code honours the settings was checked by hand: asked whether its system prompt has auto-memory instructions, `claude -p` answers YES by default and NO with `--settings '{"autoMemoryEnabled":false,…}'`; the flag mapping itself is unit-tested (`claude-common`). `dreaming-e2e.test.ts` shows the model choosing `superseded` for a recurring entry that contradicts an existing one (the stale entry is replaced, unrelated ones untouched) and writing a diary.
- **Not done**: OpenClaw's vector search, transcript ingestion as a candidate source, pre-compaction memory flush, per-user `USER.md` files, and the Dreams UI. Migrating a ClaudeClaw v2 auto-memory directory: copy it under `memory/imports/` (searchable, not injected), see `docs/MIGRATE.md`.

---

## 9. A2A

- **SDK**: `@a2a-js/sdk` 1.3 (implements A2A v1.0, with optional v0.3 compatibility). All three transports are provided:
  JSON-RPC, REST, gRPC. The README's "gRPC Node-only" means "cannot run in Workers / browsers",
  not "does not work on Bun". Tested on Bun 1.3.4 with an `@grpc/grpc-js` server + `GrpcTransportFactory`
  client; both `SendMessage` and `SendStreamingMessage` work. Agent Card location: `/.well-known/agent-card.json` (confirmed in the SDK source).
- **What is exposed**: exposed per **Agent Profile** (one Agent Card per profile, at `/<profile>/.well-known/agent-card.json`;
  the root `/.well-known/agent-card.json` serves the first exposed profile), not per chat channel. On a remote call, the session is
  `a2a:<profile>:<caller>:<contextId>`, where `<caller>` is the authenticated token name (URI-encoded; `anonymous` when the server
  runs without tokens). The caller chooses the `contextId`, so it is never enough on its own: another caller reusing it gets its own
  session. These sessions are isolated and never mixed into human conversations.
- **Same shape inside and out**: the bus already uses Envelope (A2A-shaped) internally. A local `agent_ask` is an A2A `SendMessage`
  short-circuited in-process; when the target is remote it goes over HTTP instead. For the agent, both are used exactly the same way.

| bus | A2A v1.0 |
|---|---|
| `agent_ask` | `SendMessage` (task result → caller; a non-terminal task is polled with `GetTask`) |
| `agent_trigger` | Not supported for remote agents (it throws: a remote agent has no chat here). A `uniqlaw.deliver = "own-human"` extension is a possible future addition. |
| `task_status` | Local task table (the remote task id is not exposed) |
| Inbound `GetTask` / `CancelTask` / `SubscribeToTask` | Served for the caller that created the task only; any other caller gets "task not found" |
| Turn state | SUBMITTED → WORKING → COMPLETED / FAILED / CANCELED (INPUT_REQUIRED and push notifications are not used) |

- **Security** (what the code enforces today):
  - The A2A server binds to 127.0.0.1 by default and speaks plain HTTP / insecure gRPC (no TLS yet; put a TLS proxy in front for
    anything beyond loopback).
  - Auth is bearer tokens (`auth.bearerTokens`), declared in the Agent Card's `securitySchemes`. Exposing on a non-loopback host
    without tokens is refused. Missing or wrong token → 401 with `WWW-Authenticate: Bearer`. A named token may be limited to some
    exposed profiles (`profiles`); any other profile → 403 (gRPC `PERMISSION_DENIED`). Token names are the caller identity: they
    must be unique and must not look like the generated `token#<n>`. mTLS is not supported.
  - **Anonymous mode** (loopback, no tokens): every local process — any user's — can call the exposed profiles, and all of them
    are the same caller `anonymous`, so they share sessions (per `contextId`) and can read each other's tasks. The daemon logs a
    warning at startup. Configure tokens if more than one client may connect.
  - External agents can only reach profiles listed in `expose`.
  - Inbound `a2a:` sessions are deny-by-default (`packages/core/src/a2a-policy.ts`): the profile's permissions are capped at
    `strict` (`locked` stays `locked`; `auto-allow` approval becomes `ask-operator`), and they get a fixed tool policy
    (`A2A_TOOL_POLICY`, §10.3) that denies every tool group but `web`: `chat`, `memory`, `files.read`,
    `files.write`, `bash`, `agents` (Task/Agent/Workflow/Skill), `cron`, `worker`, `xsession`, `notify` and `config`, whatever
    `settings.channels` says. The group tables are channel-policy's `TOOL_GROUPS`; the denied built-ins also go into the
    profile's `denyTools`. So the MCP gateway does not offer them `send_file`, `notify`, `agents_list`, `agent_ask`,
    `agent_trigger`, `task_status`, `worker_*`, `cron_*`, `memory_*` or any `config` tool (so MEMORY.md is not injected either).
  - They are **isolated** (`SessionSpec.isolated`): the working directory is an empty directory of their own outside the project
    and outside any git repository (`$TMPDIR/uniqlaw-a2a-<instance>/<hash of the session key>`, mode 0700, refused if someone
    else owns it or can write to it), so no project files, CLAUDE.md, git status or git user reach the context. Claude providers
    launch them with `--tools ""` (no built-in tools), `--setting-sources ""` (no user/project/local settings, CLAUDE.md, hooks,
    skills or plugins), `--strict-mcp-config` (UniQlaw's MCP server only), native memory off and without `extraArgs` — verified
    with claude 2.1.322 (`packages/claude-common/test/a2a-isolation.e2e.test.ts`).
  - Their system prompt is the exposed profile's own `expose.<profile>.prompt` / `promptFiles` plus a path-free scope instruction;
    the brand prompt, `settings.prompts.files` (IDENTITY/USER/SOUL), memory and absolute paths are never included.
  - **Fail closed**: only providers with the `isolation` capability (claude-tmux, claude-sdk) can serve remote callers. Exposing a
    profile on any other provider (codex, opencode, acp, agy, pi) is a startup error, and the core refuses to open such a session,
    unless the operator sets `expose.<profile>.unsafeProvider: true` (logged as UNSAFE at startup): those providers would run the
    remote request with the operator's settings, MCP servers and file access.

---

## 10. Permissions and security

A unified permission model, translated by each adapter into the provider's settings:

```ts
interface PermissionPolicy {
  level: "locked" | "strict" | "moderate" | "unrestricted";  // carried over from v2
  allowTools: string[]; denyTools: string[];
  approval: { mode: "auto-deny" | "ask-operator" | "auto-allow"; timeoutSec: number /* 0 = wait indefinitely */; judge?: ApprovalJudgeConfig };
  dirScope?: string[];
}
```

- claude → `allowedTools` / `disallowedTools` / `permissionMode` / `canUseTool`
- codex → approval policy + sandbox mode + `requestApproval` reply
- opencode / acp → permission settings + `request_permission` reply
- pi → `tool_call` hook (our own gate, fail-closed)

The Approval Broker receives every `permission_request`, finds the operator per §8.4, sends inline buttons,
and denies on timeout. `approval.timeoutSec: 0` waits for the human indefinitely (no timer in core, the chat adapters or pi).

### 10.4 Approval judge

An optional decision model scores each request before the operator is asked (`packages/core/src/approval-judge.ts`).
It runs in `ChannelRuntime.onPermissionInner` after the `auto-allow` / `auto-deny` short-circuits, so every provider
that emits `permission_request` gets it (claude-sdk, codex, opencode, acp, pi, claude-tmux); agy has no callback.

```jsonc
"permissions": { "approval": { "mode": "ask-operator", "timeoutSec": 0,
  "judge": {
    "provider": "typesafe-jev",            // the backend: typesafe-jev | typesafe-compatible | openai-decision
    "mode": "shadow",                      // off (default) | shadow | enforce
    "options": {                           // backend settings, validated by the backend
      "credential": { "command": "nibwarden read -n 'nw://TypeSafe API/password'" },   // any SecretRef (§10.1)
      "model": "jev-latest"
    },
    "allowAbove": 0.9,                     // floor for every kind
    "byKind": { "chat": 0.9, "worker": 0.93, "cron": 0.97, "peer": 0.97 },     // a number or "off"
    "timeoutMs": 5000,
    "audit": true
  } } }
```

**Philosophy.** The judge is the **primary filter**: its job is to cut how often the human is asked, so ordinary
agent work (compound, wrapped, quoted commands, git, make, …) goes to it like anything else. **Hard deny** is for
what policy forbids (deterministic, in code). **Escalation** is for what the judge could not see or cannot grant, and
for what it scores below the threshold. Guiding rule for the blockers: the judge may only auto-allow input it fully
and faithfully saw.

Outcomes, in order:

1. **deny**: only deterministic rules in code:
   - the profile's `denyTools`: tool names (case-insensitive), path globs, and `Bash(prefix:*)` matched against every
     simple command the line would run after **shell normalization** (`core/src/shell.ts`): words unquoted and
     unescaped (`r''m`, `"rm"`, `\rm` → `rm`), grouping stripped (`( )`, `{ }`, `!`), leading `VAR=…` dropped,
     `/bin/rm` read as `rm`, known wrappers unwrapped (`sudo`, `doas`, `env` incl. `-S`, `timeout`, `nice`, `ionice`,
     `stdbuf`, `setsid`, `nohup`, `time`, `command`, `builtin`, `exec`, `xargs`, `chroot`, `flock` incl. `-c`,
     `busybox`, `unbuffer`, `parallel`, `watch`, `strace`, sandboxes `bwrap` / `firejail` / `sandbox-exec`, …),
     reserved words dropped (`if … then rm …; fi`, loops, `case`, functions, `time -p`), the command word's comma brace
     expansion read (`{r,}m` → `rm m`), and the strings of `sh -c` / `bash -lc` / `eval`, here-strings and
     here-documents fed to a shell, `$( … )` / backtick / `<( … )` substitutions, `find -exec`, and remote / container
     commands (`ssh host …`, `docker|podman exec|run …`, `kubectl exec … -- …`) analysed as commands too. A command that
     normalizes to a denied one is denied outright. Inputs: Claude `command`, pi `bash`, opencode `{patterns,
     metadata}`, codex string or argv `command` (argv is shell-quoted back word for word);
   - the channel tool policy (case-insensitive tool names) and the `locked` level (anything not read-only);
   - writes (Write/Edit/MultiEdit/NotebookEdit, pi/opencode `write`/`edit`) outside the scope (`dirScope`, else the
     session's cwd; not at `unrestricted`), and a codex `grantRoot` outside it. Paths are checked as written **and**
     after `realpath` (the nearest existing parent for new files). **Writes made through a shell command are not
     path-checked.**
2. **allow**: only in `enforce`, when P(safe) ≥ the strictest threshold of the request's session kinds, no *allow
   blocker* applies, and only for this request (`scope: "once"`).
3. **escalate** (the operator flow) in every other case: low score, judge error or timeout, a kind set to `"off"`,
   **any inbound A2A session or turn with an A2A origin (hard-coded: config cannot enable it)**, raw TUI dialog text,
   and the allow blockers, which are kept only where the judge did not see the request or cannot grant it:
   - `input-altered`: redaction or a size cap (4000 chars a string, 8000 in all, 50 items, depth 6) changed what the
     judge saw;
   - `empty-input`: nothing to judge once model-written fields are dropped (codex `fileChange` `{grantRoot}`, legacy
     `applyPatch` `{}`);
   - `interactive-tool`: `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode` (allowing answers for the human) and codex
     `SandboxPermissions` (granted for the turn);
   - `no-once-option`: the provider offers no plain one-time allow (any allow would be wider than once; ACP never
     falls back to `allow_always`);
   - `unresolvable-command`, only when a `Bash(…)` deny rule exists: what runs is decided by text code can't see, so
     the deny rule can't be checked: a command word from a variable or substitution (`$RM`, `$(which rm)`), `eval` of
     non-literal text, unbalanced quotes; a shell reading a pipe, a file or a script (`… | sh`, `sh < f`, `bash f.sh`);
     inline interpreter code (`python -c`, `perl -e`, `ruby -e`, `node -e`/`--eval`/`-p`, `deno eval`, `bun -e`,
     `php -r`, `lua -e`, `osascript -e`, or one reading code from stdin); `awk` with `system(`/pipes; `git -c` keys
     that run programs (`*.pager`, `*.editor`, `alias.*`, `core.sshCommand`, `*.hooksPath`, `credential.helper`, …);
     a brace range in the command word; zsh-only syntax; and anything in fish or PowerShell
     (`shape.unresolvableReasons` says which).

   Compound, wrapped, quoted, piped commands and reviewer-addressed comments are **not** blockers: they reach the
   judge as typed features (below).

`off` changes nothing in what is asked (no judge call, no audit, identical prompts and launch flags). `shadow` scores
and logs every request (hard-policy rules and blockers included, as `wouldOutcome`/`wouldReason`/`blockers`) and
still escalates all of them: deploy it first and calibrate.

**Session kind**: one per origin of the turn (trusted human → `chat`; untrusted human, peer, system → `peer`;
scheduler → `cron`; A2A → `a2a`), plus the session's own (`a2a` session, `worker`; a worker's peer origins are its
owner's asks → `worker`). The strictest threshold among them applies, so a peer or cron message steered into a
human's turn makes the whole request peer- or cron-strict.

**Judge input** is minimal and trusted only, passed as typed fields: tool name, the structured input (secrets
redacted; Bash `description` and codex `reason` dropped; size-capped), `inputTrust` (a fixed note that the input is
the agent's own untrusted writing), cwd, write scope, level, session kind, a one-line channel-policy summary, and the
latest human message **only when every origin of the turn is a trusted human** (as they wrote it, capped). Shell
tools also get `shape: {segments, hasSubstitution, hasPipeToShell, wrappers[], unresolvable}` and
`reviewerAddressedComment` (a `#` comment, outside quotes, that claims approval or safety), both computed by code so
the judge can weigh them. Never tool
outputs, fetched or file content, assistant text, the provider's title, or peer, cron or A2A message text.
*Residual risk*: the input itself is model-written (shell comments, heredoc bodies, Write `content`, WebFetch/Task
`prompt`); the judge is told so and reviewer-addressed shell comments escalate, but persuasive text elsewhere in the
input still reaches it. Calibrated thresholds and the hard rules are the defense; keep `shadow` until the audit
pairs say the thresholds hold.

**Layering.** A request passes these layers in order:
1. **hard deny** for what policy forbids (deterministic code);
2. **blockers** for what the judge could not see or cannot grant (escalate);
3. **the judge**, which must reach a threshold: the session kind's, raised to `taint.taintedAbove` (default 0.97)
   when the context is **tainted** and the request is high-impact (`send`, `publish`, `delete`, `install`; configurable
   `highImpactEffects`) or reaches an external, remote, global/system or protected target (an unknown target or an
   unrecognized command counts as high-impact);
4. **the induced check**: the judge's second answer must not say the action is induced by content (P(induced) ≥
   `inducedAbove`, default 0.5, or `unclear` escalates).

Taint is the **factual** signal: the harness saw untrusted content enter the context, whatever it said. The induced
question is **auxiliary**: the judge sees the request and the context, not the content itself, and the content can
argue with it; it can only add escalations, never allow.

**Taint tracking** (`core/src/taint.ts`, `judge.taint`). Per turn (or for the whole session with `sticky: true`), the
untrusted sources that entered the agent's context, from the observed actions and the turn's origins, through a
registry of detectors (extensible like `targets`):
- web tools (WebFetch, WebSearch, fetch);
- network reads through the shell normalizer (`curl`, `wget`, `http`/`xh`, `nc`, `gh api|issue|pr|…`,
  `git clone`), and output of remote commands (`ssh host cmd`, `docker|kubectl exec`, `scp`/`rsync` from a host);
- MCP tools whose results come from third parties, by tool-name pattern (`thirdPartyTools`; defaults cover mail,
  chat, issues, docs, drives, calendars, browsers, the web, search); UniQlaw's own `agent_ask` / `task_status` results
  count as peer text;
- reads of files outside the scope, and of files inside it that this session did not create and git does not track
  (downloaded files). Files git tracks, the session's own writes and (without a repository) project files are not
  taint, unless `trustRepoFiles: false` makes the own repo untrusted too;
- peer, cron and A2A messages in the turn, and messages from untrusted humans.

The judge gets `taint: {tainted, sources: [{kind, id, at}]}` (ids are `{untrusted}` labels) and the audit line records
it with `taintStrict`. There is **no ingress scanning**: nothing reads the content itself.

**The induced question.** Every backend asks a second choice question in the same request
(`JUDGE_INDUCED_QUESTION`): does the action serve the human's request, or is it induced by content the agent read?
(`task | induced | unclear`). TypeSafe System One answers several named questions per call and OpenAI Decisions up to
400, so both backends send `safety` and `induced` together. P(induced) and the answer go to the audit line, and the
escalation note shows both scores, e.g. `🤖 Jev: 0.93 safe · induced 0.61`. A backend that answers only the first
question gets no induced check.

**Shell dialects.** The normalizer is **best effort** and reads POSIX sh / bash / dash; zsh only where it is the
same (zsh-only syntax: `=cmd`, glob qualifiers `*(.)`, `${~…}`, `=(…)` is unresolvable); fish and PowerShell not at
all (`parsed: false`: every command is unresolvable when a `Bash(…)` deny rule exists, otherwise it goes to the judge
unparsed). It always fails toward the judge or the human, never toward allow, and it is not the security boundary:
the OS sandbox, the provider's permissions and `dirScope` are. The outer dialect comes from the provider and tool
(`ProviderCapabilities.shellDialects`); inside a command it switches only on an explicit interpreter (`bash`/`sh`/
`dash -c` → POSIX, `zsh -c` → zsh, `fish -c` / `pwsh -Command` → unsupported, also inside `docker run …` / sandbox
wrappers). `shape` reports `dialect` (outer), `parsed` and `dialectSwitches`. How the providers choose:

| provider / tool | shell (dialect) |
|---|---|
| Claude Code `Bash` (claude-tmux, claude-sdk) | bash or zsh only: `CLAUDE_CODE_SHELL` when it names bash/zsh, else `$SHELL` when bash/zsh, else the first working zsh, then bash (code.claude.com/docs/en/env-vars) |
| Claude Code `PowerShell` | pwsh (unsupported) |
| codex | argv vectors, no outer shell (`argv`); the common `["bash", "-lc", script]` switches to POSIX for the script |
| opencode `bash` | its `shell` config, else `$SHELL`, else `/bin/bash` (UniQlaw reads `$SHELL`; a config override isn't seen) |
| pi `bash` | `/bin/bash`, else bash on `PATH`, else `sh` (a custom `shellPath` isn't seen) |
| acp, agy, others | not declared: `unknown`, read as POSIX |

**Context: what the judge knows besides the request.** So that sensible mid-task actions can pass (the human said
"finish developing model X"; the agent hit a full disk and wants to clear old outputs), three more fields, each with
an explicit trust level:

- `actionTrace` (harness-observed): this turn's tool actions before the request, oldest first, at most 20. Trusted as
  facts: the tool, the **normalized** command (the simple commands that ran) and `ok`. Write/Edit/NotebookEdit
  entries carry only the path and the content size, never content; other tools their redacted input. Read-only
  diagnostic commands that print counts, sizes, names or states (a generic table: `df`, `du`, `free`, `ls`, `stat`,
  `wc`, `pgrep`, `lsblk`, `ip addr`, `nvidia-smi`/`rocm-smi`, `git status|branch|rev-parse`, `git diff --stat`,
  `systemctl is-active`, `docker images`, `npm ls`, `pip list|freeze`, …, optionally piped through
  `head`/`grep`/`sort`/…; no redirect, substitution or wrapper) also get `observedOutput`, capped at 400 chars and
  marked `{untrusted}`: it is the system's own output, but file names and states can still carry text. Nothing that
  prints file contents or free-form messages (`git log`/`show`/`diff`, `ps`, `systemctl status`, `docker ps`,
  `pip show`, `cat`, …) and no other output is ever included. The trace comes from the `tool_start` / `tool_end` events every
  provider emits (claude-tmux: its session jsonl; claude-sdk, codex, opencode, pi, acp, agy: their structured
  events; codex's `tool_end` summary now carries the command output). A provider declaring `toolTrace: false` sends
  `available: false`: unknown, not empty.
- `targets` and `unrecognized`: the resources the request acts on, for any tool and command
  (`core/src/targets.ts`). Each target has a `kind` (`path`, `git-ref`, `url`, `process`, `package`, `service`,
  `device`, `remote-host`, `secret-ish`), an `effect` (`read`, `create`, `modify`, `delete`, `execute`, `send`,
  `install`, `publish`) and provenance: `createdThisSession`, `inScope`, `existsNow`, `unresolved` (+ `reason`),
  `remote`, and kind details (paths: git `tracked`/`untracked`/`ignored`/`not-in-repo`, `category`
  generated/source/config/data/secret, mtime, `modifiedThisSession`, size with a bounded walk,
  `createdInsideThisSession`; git refs: `isDefaultBranch`, `isProtected`, `force`, `remote`; urls: `hostClass`
  localhost/lan/project-remote/external and the method; processes: `ownedBySession`, `ownedByUser`, name; packages:
  `scope` project/global/user/system, manager). Targets come from small extractors in registries: per normalized
  shell command name (through the shell normalizer, so wrappers, `sh -c` and substitutions are seen), per structured
  tool (Read/Write/Edit/WebFetch, …), and the obvious `path`/`url` arguments of MCP tools; per-kind enrichers add the
  provenance. A new kind or command is one more registry entry. A command with no extractor gives no target and
  appears in `unrecognized` (never guessed); `ssh host cmd` / `scp` / `rsync host:` give a `remote-host` target and
  report what the remote command acts on as `remote: true`, unresolved locally. Globs and variables are `unresolved`.
  Trust: `kind`, `effect` and the provenance flags are computed by code; ids, `via`, free-form details and
  `unrecognized` names are agent-supplied text and appear as `{untrusted: …}`.
  **createdThisSession** comes from the session ledger: what this session's observed actions created (Write, `mkdir`,
  `touch`, `>` redirects, `-o`/`--output` files, packages, `docker run`, `tmux new`), with spoof checks:
  - paths by their **resolved real path** (a link the agent made to elsewhere is not "its" target), counted when a
    create action targeted them (or a parent) and they were new then or their **birth time** is after the session
    started (never mtime: no birth time means not created, a false negative);
  - git refs only if the ref **did not exist** before the command (`checkout -B` / `-C` / `branch -f` on an existing
    branch is a reset, not a creation);
  - processes only by pid, and only after checking that the pid started after the session began (`/proc/<pid>/stat`
    start time; `ps -o lstart` on macOS) and descends from the session's process root (`AgentSession.processRoot`:
    claude-tmux's pane process; other providers report none, so no pid counts as theirs). Numbers in output are never
    trusted by themselves; killing by name is never "owned by this session".
  The ledger is in memory and starts again when the session reopens. It learns from `tool_start`: a provider that
  reports a tool only after it ran (claude-tmux reads its jsonl with a lag) can make a creation look pre-existing, a
  false negative.
- `agentRationale` (**untrusted**, model-authored): what the agent wrote about its own call (Bash `description`,
  codex `reason`, a TUI dialog's text), in its own labelled field; `input` keeps its stripped form.
- `humanRequest`: the human's own words, trusted as their instruction. Quoted or pasted parts (`>` lines, code
  fences) go to `humanRequestQuoted` as `{untrusted}`; own words longer than 600 characters become `{untrusted,
  reason}` (they may carry pasted content).

Secrets: besides the earlier patterns, `redactString` masks config-style keys (`"api_key": "…"`, YAML/INI
`password:` / `secret =`, `token=`), with whole-word key names (`monkey:` / `tokenizer:` stay).

The judge's question states each field's trust level and a generic decision guide in terms of effect × provenance ×
task: acting on resources this session created, inside scope, in service of the human's task is consistent;
acting on pre-existing, tracked, protected, global, external, remote or secret resources the task did not mention
needs much stronger evidence. The audit line records `actionTrace`, `targets`, `unrecognized` and `agentRationale`
(redacted).

**Audit**: `<stateDir>/approvals/YYYY-MM.jsonl` (UTC month), one line per request (`id, ts, channelKey, sessionKind,
provider, tool, structured, inputHash, input` (redacted), `judge, model, pSafe, threshold, mode, outcome, reason,
wouldOutcome, wouldReason, blockers, latencyMs, error`), then `{id, humanDecision, decidedAt}`
(`allow | deny | timeout | no-route | cancelled`). These pairs are the calibration data. The transcript
`permission` record gains `by` (`judge | policy | operator`) and `pSafe`.

**Escalated prompts** start with the score, e.g. `🤖 Jev: 0.87 safe (needs 0.90)` or `🤖 Jev: no score (…)`.

**Prompts never block the session.** A permission request is handled off the event loop (prompts still one at a
time, in order). `askChoice` takes an `AbortSignal`: when the provider withdraws the request
(`permission_withdrawn`: claude-tmux's dialog stayed gone for 3 s (`timings.dialogWithdrawnMs`; a redraw or resize
that hides it briefly, or redraws the same tool and request with other option text, keeps the same request) or was
replaced by a different one; the Agent SDK aborted `canUseTool`), when the turn ends, or when the session closes, detaches or is reset, the chat prompt is cancelled
("↩️ Cancelled — resolved elsewhere", buttons removed, the adapter's pending entry dropped) and nothing is answered.
So `timeoutSec: 0` can't freeze a turn or a graceful restart's drain. This applies with the judge off too.

**claude-tmux: the `PermissionRequest` hook.** With a judge on (and `ask-operator`), claude-tmux writes its settings
(native memory and an HTTP hook) to `<stateDir>/claude-tmux/<session>/settings.json` (mode 0600) and passes
`--settings <that file>`: the hook URL carries a token and must not sit in argv. The file is deleted when the session
closes for good and when it is relaunched with the judge off (a daemon restart's detach keeps it: the live claude
still uses it). The URL uses a **hook-only token**
(`/hook/<token>/permission`; it cannot open `/mcp/…`, and the MCP token cannot open the hook). The runtime judges
the **structured** `tool_name`/`tool_input`: allow or hard-policy deny answer the hook; escalate returns `{}` and
Claude shows its dialog. The scraped `permission_request` reuses that verdict only when it shows the same request
(tool, or `unknown`, and the command / path / URL found in the dialog text); otherwise it is escalated with no score
(`hook-unmatched`). Hard-policy rules run again on the dialog, and verdicts are dropped when the turn ends or is
interrupted (60 s at most). Judge off: no hook, and the launch flags stay exactly as before (inline
`--settings` JSON only when native memory is off).
Checked on claude 2.1.322: the hook fires in `default` mode only when a dialog would appear; `{}`, an error or an
unreachable daemon fall through to the dialog; an allow is not remembered; `--settings` hooks also apply under
`--setting-sources ""`; `disableAllHooks: true` in any settings layer turns it off (then the dialog path works as
before). Under the `auto` permission mode the classifier decides first and the hook sees only what it escalates:
the full benefit needs `default` mode (`profile.options.permissionMode`), a later, separate step.

**Backends** (`judge.provider`; settings in `judge.options`, `credential` / `model` at the top level are shorthands).
Every backend asks the same question (`JUDGE_QUESTION` in core: a `safe | unsafe` choice over the typed request) and
returns P(safe):

| provider | protocol | options |
|---|---|---|
| `typesafe-jev` | TypeSafe System One, hosted: `POST https://api.typesafe.ai/v1/systemone`, one Choice question; P(safe) = `answers.safety.probabilities.safe` (calibrated per TypeSafe's docs) | `credential` (required), `model` (`jev-latest`), and the `typesafe-compatible` options |
| `typesafe-compatible` | the same protocol on a self-hosted server | `baseUrl` (required), `credential` (optional), `model`, `authHeader` (`authorization`), `authScheme` (`Bearer`; `""` = bare key), `headers`, `name` |
| `openai-decision` | OpenAI Decisions API: `POST https://api.openai.com/v1/decisions`, model `gpt-6-luna` (the only one supported), the request as an `input_json` part, one `choice` question with `safe` / `unsafe` and the fallback `uncertain` the docs recommend; P(safe) = the `safe` entry of `probabilities` (so `uncertain` escalates); a `refusal` answer is an error (→ escalate) | `credential` (required), `baseUrl` (`https://api.openai.com/v1`), `model`, `organization`, `project`, `headers`, `name` (`Luna`) |

OpenAI's Decisions docs return probabilities but make no calibration claim; they say to set thresholds from labelled
examples, which is what `shadow` and the audit pairs provide. Keys are resolved from the SecretRef on the first
request and kept in memory only. A `command` ref works with any secret CLI, e.g. `nibwarden read -n nw://<item>/<field>`,
or start the daemon under `nibwarden run --` with an `{ "env": … }` ref.

### 10.3 Channel capabilities and group wake rules

The unit of control is the channel (chat), not the user. `settings.channels` gives each chat a set of **tool groups**;
core resolves it into `SessionSpec.toolPolicy` when the chat's session opens. One table (`TOOL_GROUPS` in
`core/src/channel-policy.ts`) maps each group to concrete tools:

| group | UniQlaw MCP tools | Claude Code built-ins (names as of claude 2.1.322) |
|---|---|---|
| `chat` | `send_file` (own chat only unless `notify` is granted) | `TaskCreate/Get/List/Update`, `ToolSearch`¹, `AskUserQuestion`, plan mode, `ReportFindings` |
| `memory` | `memory_write`, `memory_search`, `memory_get` | — |
| `web` | — | `WebSearch`, `WebFetch` |
| `files.read` | — | `Read`, `Grep`, `Glob`, `LSP` |
| `files.write` ⚠ | — | `Write`, `Edit`, `NotebookEdit`, worktrees |
| `bash` ⚠ | — | `Bash`, `Monitor`, `PowerShell`, `TaskStop` (anything that runs code) |
| `agents` | — | `Task`/`Agent`, `Workflow`, `Skill` (sub-agents get the session's own tool set) |
| `cron` ⚠ | `cron_list`, `cron_save`, `cron_delete` | `CronCreate/Delete/List`, `ScheduleWakeup`, `RemoteTrigger` |
| `worker` ⚠ | `worker_start`, `worker_stop` | — |
| `xsession` ⚠ | `agents_list`, `agent_ask`, `agent_trigger`, `task_status` | `SendToProject` (`ListAgents` / `SendMessage` are always off) |
| `notify` | `notify` (and `send_file` to other chats) | `PushNotification`, `Artifact*`, `DesignSync` |
| `config` | `daemon_restart` (also limited to the operator's own chat, in a turn the operator started) | — |

¹ `ToolSearch` loads deferred MCP tools, so it is not tied to `chat`. Deny mode never removes it: UniQlaw plugin tools
that no group names stay callable there. Allow mode keeps it while any group with UniQlaw MCP tools is granted.
`--strict-mcp-config` (any policy) leaves the UniQlaw gateway as the only MCP server: on claude 2.1.322 it also drops
Claude Code plugin servers and claude.ai connectors, not just the user's `mcpServers`.

**⚠ Admin-level groups (v1).** `bash`, `files.write`, `cron`, `worker` and `xsession` grant effectively full access,
because each one lets a restricted chat reach something unrestricted:
- a cron job runs in its own `cron:<job>` session, and a worker runs under its own profile;
- `agent_ask` / `agent_trigger` reach other chats' sessions;
- writes to `.uniqlaw/jobs/*.md`, `.uniqlaw/settings.json` or `.claude/settings.json` hooks change what runs next;
- a shell can do all of the above.

There is no policy inheritance across these hops yet. The daemon logs a warning at startup for every restricted channel
(or `defaults`) that grants one of them. Give them only to chats whose members you would trust with the machine.

**Sensitive reads.** `.uniqlaw/` holds other chats' transcripts (`state.db`), settings, logs and the per-session MCP
gateway tokens (`claude-tmux/*/mcp.json`). Every restricted chat on a Claude provider gets
`Read(./.uniqlaw/**)` / `Grep(…)` / `Glob(…)` deny rules (relative to the session's cwd, the project directory), but
Claude Code matches `Grep(…)` rules on the `path` argument only, but it also leaves denied paths out of Grep results,
so `path: "."` with `glob: ".uniqlaw/**"` finds nothing there (checked on claude 2.1.322; pinned by
`claude-common/test/tool-policy.e2e.test.ts`). `files.read` still reaches the rest of the project (including `memory/`) and anything else the OS user can read. A shell
(`bash`) bypasses these rules entirely.

- `tools: [...]` is an allow list: only those tools exist. Claude gets `--tools <built-ins>` and `--strict-mcp-config`
  (no MCP servers from the user's own config), plus the granted UniQlaw tools named one by one in `--allowedTools`.
  Built-ins no group names (`Task`, `Skill`, …) are off.
- `tools: "*"` keeps everything; `deny` subtracts groups (`--disallowedTools` for built-ins, gateway filtering for MCP).
  Any policy, allow or deny, also gets `--strict-mcp-config`: the user's own MCP servers (browser automation, mail, …)
  belong to no group, so no restricted chat gets them. A chat with no policy keeps its exact old launch flags.
- The MCP gateway never registers a tool the caller's channel lacks (not listed, not callable), checked per request.
- Enforcement of built-in tools is the provider's job (`ProviderCapabilities.toolPolicy`, implemented by claude-tmux and
  claude-sdk). If a channel restricts built-in tools and its provider can't, the session refuses to open (fail closed).
- Only chat sessions take a policy from `settings.channels`. Inbound A2A sessions always get the fixed `A2A_TOOL_POLICY`
  (see A2A above; their built-in tools are covered by the `isolation` capability). Internal sessions (heartbeat,
  `cron:<job>`) and workers keep their own settings, also when they post into a chat. A job whose target *is* a chat session runs inside that session, with its tools.
- A policy change is a launch-flag change, so a claude-tmux process reattached after a reload is respawned (`--resume`)
  with the new tool set (same fingerprint mechanism as a permission-mode change). Until then it keeps its old built-in
  tools: a turn that was running across the reload finishes with them, and the respawn happens once the pane is idle.
  UniQlaw MCP tools change at once (the gateway checks every request).
- Migration: no `channels` section, or no entry and no `defaults` for a chat, means unrestricted (the behavior before `channels` existed).
  Only an explicit `defaults` entry narrows chats without their own entry.

Group chats (`groups`, per channel in `groups.channels`) add wake rules on top of `mode`: `allowFrom` lists the platform
user ids allowed to wake the agent (`"telegram:<from.id>"`, `"discord:<author.id>"`; in a per-channel entry a bare id
means that channel's platform, in the global list it matches no one and is warned about; empty = anyone the platform
allowlist lets through). The check runs in core on `InboundMessage.sender.id` from the platform payload, before
the agent sees anything; names and message text never count. `others` decides what happens to messages that don't wake
the agent: `context` keeps them (up to `historyLimit`) as background for the next woken turn, labelled with the sender's
id; `ignore` drops them. DMs are never gated.

### 10.2 Settings layering: inherit + override (§13 #9)

```
provider's own global settings (user level: settings, hooks, plugins, skills, MCP, login)   ← inherited
        ↓ overridden by
agent project directory settings (.claude/, .codex/, opencode.json, .pi/ … under the cwd)
        ↓ overridden by
CLI flags / injected settings UniQlaw passes on every launch                               ← enforced
```

| provider | Inherited from | UniQlaw's enforcement layer | Confirmed override order |
|---|---|---|---|
| claude-tmux / claude-sdk | `settingSources: user, project, local` | `--permission-mode`, `--disallowedTools ListAgents SendMessage`, `--mcp-config`, `--append-system-prompt` | CLI > local > project > user |
| codex | `~/.codex/config.toml`, global MCP | Process-level `--disable` (memories etc.), model / approval / sandbox resent on every turn, thread `mcp_servers` | Per-turn overrides > config |
| opencode | `~/.config/opencode`, `~/.local/share/opencode` (inherited by default since M5) | `OPENCODE_CONFIG_CONTENT` (permission rules, MCP, instructions) | Confirmed in source: remote → global → `OPENCODE_CONFIG` → project files → `.opencode/` → **`OPENCODE_CONFIG_CONTENT`** (applied last) |
| pi | `~/.pi/agent` (or `PI_CODING_AGENT_DIR`); the agent project's `.pi/` is trusted by default (`trustProject: false` turns it off) | SDK parameters (tool_call permission gate, MCP) | SDK parameters take effect directly; all pi profiles in one instance must share one agent directory (pi's MCP OAuth reads process-level environment variables) |
| agy | The user's `HOME` (default; `isolateHome: true` switches to the instance directory) | `--settings` (this session only, not written back) | `--settings` overrides settings.json |

**Exception**: when a profile uses a `provider-login` credential with a `home` set (a different account), that separate directory is used and the user's global settings are not read.

**Known limitation (same as v2)**: Claude Code's `permissions.allow` is **merged** across layers; an upper layer can only override with deny and cannot remove a lower layer's allow. So tools allowed in the user's personal settings also pass straight through in UniQlaw without operator approval. UniQlaw's hard limits must be expressed as deny (`denyTools`, `--disallowedTools`, the project's `permissions.deny`); deny always wins.

### 10.1 Credentials layer

Credentials are **named, reusable settings**. Profiles reference them, and the adapter converts them into a form the
provider understands (environment variables, config directories, SDK parameters) only when it launches the provider. uniqlaw itself does not store secret values, only
"where to get them".

```ts
type Credential =
  // Direct APIs
  | { kind: "anthropic-api-key"; key: SecretRef }
  | { kind: "openai-api-key";    key: SecretRef; baseUrl?: string; org?: string }
  | { kind: "gemini-api-key";    key: SecretRef }
  | { kind: "openai-compatible"; baseUrl: string; key?: SecretRef }        // vLLM / Ollama / llama.cpp / OpenRouter…
  // Three major clouds
  | { kind: "aws";    region: string; profile?: string; roleArn?: string;  // defaults to the AWS SDK credential chain (env / profile / SSO / IMDS)
                      accessKey?: SecretRef; secretKey?: SecretRef; sessionToken?: SecretRef }
  | { kind: "gcp";    project: string; location: string;                    // defaults to ADC
                      serviceAccountFile?: string; impersonate?: string }
  | { kind: "azure";  endpoint: string; deployment?: string; apiVersion?: string;
                      auth: { type: "api-key"; key: SecretRef } | { type: "entra" /* DefaultAzureCredential */ } }
  // Subscription account / interactive login (stored in an isolated provider home)
  | { kind: "provider-login"; provider: "claude" | "codex" | "agy" | "opencode" | "pi"; home: string };

type SecretRef = { env: string } | { file: string } | { command: string };   // no plaintext; can hook into 1Password / pass / vault CLIs
```

Credentials supported per adapter (each verified during M1–M3 implementation):

| adapter | Direct API key | AWS Bedrock | GCP Vertex | Azure | Subscription / login |
|---|---|---|---|---|---|
| claude-sdk / claude-tmux | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_USE_BEDROCK` + AWS chain | `CLAUDE_CODE_USE_VERTEX` + ADC | `CLAUDE_CODE_USE_FOUNDRY` | claude.ai (`CLAUDE_CONFIG_DIR`) |
| codex | `OPENAI_API_KEY` | ⚠️ custom model provider | ⚠️ custom model provider | Azure OpenAI model provider (config) | ChatGPT login (`CODEX_HOME`) |
| opencode | Per-provider keys | ✅ built-in Bedrock | ✅ built-in Vertex | ✅ built-in Azure | Per-provider login (XDG directories) |
| agy | `GEMINI_API_KEY` ⚠️ | — | `GOOGLE_GENAI_USE_VERTEXAI` + ADC ⚠️ | — | Google account (directory override method ⚠️) |
| pi | OpenAI / Anthropic / Gemini / any OpenAI-compatible | ✅ Bedrock | ✅ Vertex | ✅ Azure OpenAI | OAuth (inside `PI_CODING_AGENT_DIR`) |

The environment variable names in the agy cells were found in binary strings and have not been tested yet (⚠️).

**pi is the fallback route for "three major cloud API formats"**: pi-ai natively supports Bedrock, Vertex, Azure OpenAI and every
direct API, so any cloud that no provider adapter supports can be covered with a pi profile.

---

## 11. State storage

```
.uniqlaw/
  settings.json            settings (edited by the user)
  state.db                 SQLite (bun:sqlite): sessions, bindings, tasks, cron lastFiredAt
  inbox/                   (no longer needed: the bus uses a queue table in state.db)
  history/<session>.jsonl  only used by providers with resume=core-managed
  logs/
```

SQLite is used because bus task state, cron catch-up runs (a v2 TODO) and the A2A task store all need transactional
storage. `@a2a-js/sdk` itself supports a SQLite task store.

---

### 11.1 v2 → uniqlaw migration (done by an agent following a document)

**No fixed migration script.** Migration is a one-time job, and every v2 install is a little different: keys left over from v1, hand-edited files, empty allowlists, timezone formats. A hard-coded converter either guesses wrong or needs endless special cases. Instead there is an operating guide for agents, [`docs/MIGRATE.md`](MIGRATE.md): it has a mapping table, hard rules (stop v2 first, treat v2 files as read-only, never print secrets, stop and ask whenever the user needs to decide something), and example snippets (importing sessions with `StateStore`). The agent reads the actual files, shows the user a plan first, writes only after confirmation, and finally runs `uniqlaw doctor` to verify. The Claude Code plugin's `/uniqlaw:migrate` is simply "follow this document".

Compatibility code kept in the codebase (for migrated data, not a migration tool):

| Location | What it is compatible with |
|---|---|
| `provider-claude-tmux` `legacy.ts` | Before the first `--resume`, shuts down v2 `claudeclaw-*` sessions on the default tmux socket that are still running the same session |
| core runtime | Data in `pending_input` with `source: "v2-inbox"` is put into the prompt using v2's inbox format |
| scheduler | v2's cron `.md` format, `UTC±H` timezones |
| platform-discord / slack / line | Accept v2 setting field names (including `messageStream`) |
| platform-telegram | Token accepts a string (v2-compatible); SecretRef recommended |
| model router | Reads v2's `agentic` block directly (`profiles.<p>.options.agentic`) |
| `uniqlaw doctor` / `init` | Detects whether v2 is running and whether it uses the same bot token; suggests migration when v2 settings exist |

v1 → uniqlaw: not directly supported; first upgrade to v2 with v2's `/claudeclaw2:migrate`.

### 11.2 Multiple claws on one machine (multi-instance isolation)

**Instance = one uniqlaw project directory** (where `.uniqlaw/` lives). Each instance has its own instance id
(`settings.instance.id`, generated by default from a hash of the directory path), and every resource that could collide is isolated by instance id:

| Resource | Isolation |
|---|---|
| state / log / lock | Each has its own `.uniqlaw/`; at startup it takes `.uniqlaw/daemon.lock`, so the same instance cannot start twice |
| ports (web, MCP Gateway, A2A, LINE webhook) | Default `0` (auto-assigned); the actual ports are written to `.uniqlaw/runtime.json` for the CLI and skills to read; fixed ports can be set in settings and are checked for conflicts at startup |
| tmux | Dedicated socket: `tmux -L uniqlaw-<instanceId>`, with session names also prefixed by the instance; never mixed with the user's own tmux or other instances |
| provider config directories / login accounts | Each `provider-login` credential specifies its own home, and the adapter points to it via environment variables: claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME`, pi `PI_CODING_AGENT_DIR`, opencode `OPENCODE_CONFIG_DIR` + `XDG_*`, agy ⚠️ (if no dedicated variable is found, override `HOME` entirely). Two instances can use different subscription accounts, or deliberately share the same home |
| provider subprocesses | Each session's subprocess environment carries only its profile's credentials and does not inherit the daemon's full environment (so instance A's key cannot leak to instance B's agent) |
| Native cross-session channels | Disabled per the §5.2 rule; additionally ensure the Claude messaging socket and codex app-server are not shared |
| A2A | Each instance has its own Agent Card; multiple instances on the same machine can be configured as remote A2A peers of each other |
| Platform bots | The same bot token cannot be long-polled by two instances at once (Telegram would fight over it) → at startup a token hash is registered in `~/.local/state/uniqlaw/claims/`, and a duplicate refuses to start |

`uniqlaw ls` lists every instance on the machine (scanning the claims directory + each `runtime.json`): status, ports, profiles, session count.

### 11.3 Graceful restart / reload

A restart used to cut every running turn off, including the one that asked for it (an agent ran `uniqlaw reload` mid-turn and its reply was lost). Now both kinds go through one coordinator (`core/restart.ts`):

| | what it restarts |
|---|---|
| **reload** (`uniqlaw reload`, `POST /api/reload`, `SIGHUP`) | in-process, with fresh settings; already-loaded code stays |
| **restart** (`uniqlaw restart`, `POST /api/restart`, the `daemon_restart` tool) | a new process (new code and settings). The old process stops (lock, ports and bot claims released), starts `argv` again detached and waits until the new one is up (`runtime.json` names its pid; `UNIQLAW_RESTART_READY_MS`, default 60 s); then it writes an ack file and exits 0. The new process writes `runtime.json` but takes nothing over from the old one (reattaching sessions, the restart record, deferred input, open tasks) until it sees that ack (or the old pid is gone). If it exits or doesn't come up in time, the old one logs `RESTART FAILED`, sends it SIGTERM (`UNIQLAW_RESTART_KILL_GRACE_MS`, default 15 s) then SIGKILL, waits until it has exited, and starts the daemon again in-process on the code it has; the record is untouched, so the notice says the restart failed (with no record left the operators are told directly). Only if that fails too does it exit 1. Signal handlers are installed before a start: a SIGTERM during one is honoured once it has finished, and an abandoned start takes nothing over. **Supervisors:** a system service systemd started directly (`INVOCATION_ID` / `NOTIFY_SOCKET` set, the process's cgroup is a `*.service` unit, and its parent is pid 1) exits `75` instead and lets systemd start the new process — `KillMode=control-group` would kill a detached child; the unit needs `Restart=on-failure` (or `always`). Anything else spawns (a terminal, a `cron.service` job, a CI runner, a user-manager unit whose parent is not pid 1); `UNIQLAW_RESTART_MODE=exit` / `spawn` forces either mode |

1. **Request** returns at once (an agent's own turn must be able to finish). `--in 10m` / `--at 03:00|ISO` schedule it (kv `restart-pending`; re-armed by a reload in between, dropped if its time passed while the daemon was down); `--now` skips the wait; `--cancel` cancels and releases held input. Settings are validated at request time and again before stopping (invalid, or a reload that refuses them → the drain ends, held input runs, the requester is told). Requests due now merge into the drain in progress (restart beats reload); requests for later merge into the one scheduled restart (restart beats reload, earliest time wins). The two are separate: `uniqlaw reload` before a 03:00 restart reloads now and keeps the 03:00 restart. Who asked: the calling session for the tool; for the CLI `--from <session>`, else `$UNIQLAW_SESSION` (set in every provider child's env), else `cli`. The API trusts a session name only with proof — `web.token` was presented, or `fromToken` is that session's own gateway token (the CLI reads it from `.uniqlaw/gateway.json`, mode 0600) — otherwise the requester is `api`, so another local user can't make a session receive the notice. This is **not a session boundary**: `fromToken` only proves read access to `gateway.json`, which every agent with Bash or Read on the project (any session running as the daemon's user) has, so such an agent can name any session as requester. It only keeps other OS users and unauthenticated API callers out; `daemon_restart` itself is gated by origin, below. `daemon_restart` works only in an operator's own chat (with the `config` tool group if the chat has a tool policy, §10.3; never in inbound A2A sessions) **and** in a turn that includes a message from an operator: peer (`agent_ask` / `agent_trigger`), cron and async-result turns are refused, so nobody can restart the daemon by messaging the operator's session.
2. **Drain.** No new turns: `ChannelRuntime.enqueue` and `drain()` hand inputs to `ChannelManager.deferInput`, which writes them to `state.db` `deferred_input` (write-through, so a crash mid-drain loses nothing) and tells a human once per chat that the message waits. No steer / interrupt into a running turn either. One exception: an `agent_ask` from a session whose turn is running (that turn waits for the answer). Blocking calls that could only be answered after the restart fail fast: `agent_ask` with `wait` from a non-running caller, `complete()` (dreaming), inbound A2A. Running turns get `restart.drainTimeoutSec` (default 120 s); "running" includes a rate-limit backoff and a turn still posting its end (`ChannelRuntime.busy`). Cron jobs due during the drain fire into `deferred_input` and run after the restart. Jobs due in the stop → start gap (≤ 15 min since the previous process's last tick) are caught up once on start even with `catchUpHours: 0` — but only when the previous process left a **restart or reload** record: a deliberate `uniqlaw stop` / start or a crash is ordinary downtime, which `catchUpHours` is for. A dreaming sweep due during a drain is skipped (`complete()` fails fast), not replayed.
3. **Persist** (kv `restart-record`): kind, who, reasons, time, where each requesting session's reply goes, the turns still running at the timeout (session, whom they answered, whether the provider process survives), the number of deferred inputs (runtime queues are flushed into `deferred_input` too), and the open bus tasks. A turn whose provider dies with the daemon (claude-sdk, codex, …) has its human messages queued again, each with its own origin and text (steered ones included; peer, cron and result inputs and slash commands are not re-sent), and its notice tells the agent to answer them and check for half-done work. `SIGTERM` / `SIGINT` (`uniqlaw stop`) write a `stop` record without draining, so turns cut off by a stop are reported on the next start too.
4. **Come back.** Before sessions are restored, every task still `submitted`/`working` is either re-armed (its request is in `deferred_input`, or the turn answering it kept running in a reattached session: `inflight-turn` now keeps peer ask/trigger origins) or failed with "the UniQlaw daemon restarted before it finished" — the asking session gets that as a failed `agent_ask` result (every task the record lists; after a crash, with no record, only tasks active within the last hour — older ones are failed quietly). A re-armed task whose resumed turn never shows up (it ended while the daemon was down, or another turn starts first; at most 120 s) is failed the same way, so no asker waits forever. Once platforms are up: the record is deleted, deferred input is replayed, and a `[uniqlaw] daemon restarted at … (reason; requested by …). Interrupted: … . Queued messages replayed: N.` notice goes as a new turn to the requesting session and to every session that had a turn cut off (with what to do: "resume it" or, when its process survived, "it may have finished on its own"). The notice is a scheduler-origin turn (`job: uniqlaw-restart`); for a chat it is delivered to the chat the requester / interrupted turn was answering, so the agent's confirmation reaches its human whatever `backgroundNotify` says; workers and internal sessions keep their background routing (a worker's reply never lands in the human chat its task came from). A session a human holds is not driven: a worker held from a chat gets notices and replayed system input as unread notes (the human's own messages still go through), and a session handed to a terminal is not reopened.
5. **Reattach.** A claude-tmux session survives; if it is still in the interrupted turn, that turn claims its resumed origins first (queued input, including the notice, waits up to 3 s after reopening for that) and the notice follows as the next turn. `detach()` saves the jsonl read position (`claude-tmux/<session>/tail.json`) and a reattach continues from it, so a reply claude wrote while the daemon was down is emitted as a turn and delivered to the chat it answers, not skipped. If claude exited meanwhile (dead pane), the session is spawned again with `--resume`, which appends to the same `<id>.jsonl`, so the saved position still applies and is read once claude is ready. A stale-launch respawn (`--resume` with new flags) keeps the same session object and tailer on the same file.

**Delivery guarantees.** User input (everything in `deferred_input`) is **at-least-once**: replay only claims a row, and the row is deleted when the turn that consumes it starts or it is steered into a running one (or the input is dropped: queue cap, `/stop`, session failed to open). A crash, kill or failed reload before that leaves the row, and the next start unclaims it and replays it again. Restart notices are **at-most-once**: the record is deleted before any notice is sent, so a crash right after the start never notifies twice. A crash between persisting and exiting (or mid-drain) is covered because everything is in `state.db` before the process stops. `Daemon.stop()` is idempotent and single-flight (a `SIGTERM` during a restart waits for the same stop).

## 12. Repo structure (Bun workspaces)

```
packages/
  core/               types, Session Manager, Router, Bus, Approval, Output Pipeline, State
  daemon/             bootstrap, settings loading/validation, plugin loader
  mcp-gateway/        Streamable HTTP MCP server, per-session token, tool registry
  claude-common/       jsonl parser, system prompt / permission flags, session management (shared by both claude adapters)
  provider-claude-sdk/
  provider-claude-tmux/
  provider-codex/
  provider-opencode/
  provider-acp/
  provider-pi/
  platform-telegram/  platform-discord/  platform-slack/  platform-line/  platform-web/
  scheduler-cron/     scheduler-heartbeat/
  transport-a2a/
  cli/                uniqlaw init|doctor|start|stop|reload|restart|status|ls|send|trigger|mcp-shim
  credentials/        Credential resolution, SecretRef (env / file / command), conversion to per-provider env
  testkit/            provider-mock, platform-mock, capability contract tests
```

`testkit` provides **provider contract tests**: every adapter must run the same test set (send → event sequence,
interrupt, steer, permission, resume, cross-session MCP isolation, native cross-session tools disabled), and the declared capabilities must actually pass.

---

## 13. Decisions made (2026-11-02)

| # | Question | Decision |
|---|---|---|
| 1 | SDK or tmux for Claude | **Both**: `claude-sdk` + `claude-tmux`, sharing `claude-common` (§5.2). Migration defaults to tmux |
| 2 | Runtime | **Bun**. All three A2A transports (including gRPC) tested working on Bun 1.3.4 |
| 3 | Different providers for different channels | **Yes** (§4 Binding) |
| 4 | A2A exposure granularity | **Per Agent Profile** (§9) |
| 5 | v2 migration | **Yes**: initially written as a `uniqlaw migrate` script, later changed to a document for an agent to follow, `docs/MIGRATE.md` (§11.1) |
| 6 | Authentication policy | **Compatibility and support only**: every method a provider can use (subscription login, API key, cloud credentials) is supported; use is the user's responsibility (goal 8, §10.1) |
| 7 | Cloud LLMs | **Full support for the three major clouds (Bedrock / Vertex / Azure) + direct APIs**; API keys, ADC, AWS chain and Entra ID must all be configurable (§10.1); **multiple claws can run on one machine** (§11.2) |
| 8 | Google's coding agent | **Antigravity CLI (agy)**; Gemini CLI is not a support target; the API route for Gemini models goes through pi (Gemini API / Vertex) |
| 9 | Provider user-level settings | **Keep v2's "inherit + override"**: each provider reads its own global settings and hooks as usual (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.pi/agent`, agy's HOME), so memory layers like claude-mem keep working (exception: Claude Code's built-in auto-memory is turned off while UniQlaw memory is on, §8.7); UniQlaw's mandatory rules override them through the agent project directory settings and CLI flags (see §10.2) |
| 10 | DM sessions | **One session per DM** (changed 2026-11-08, following OpenClaw's approach). v2 collapsed all DMs into `global`: different users and platforms shared one conversation context, so with multiple users each could see what the others had asked. DM keys are now `telegram:<userId>`, `discord:dm:<userId>`, `slack:dm:<userId>`, `line:<userId>`, and `parseTarget` ↔ `channelKeyForTarget` round-trip. `global` becomes an ordinary internal session name. Merging the same person across platforms into one session is out of scope for this change |
| 11 | Sessions and models for heartbeat / cron | **Run in their own internal sessions by default** (`heartbeat`, `cron:<job>`); `profile` pins a profile, `model` sets the model for a single turn; talking to people goes through bus tools (§8.5) |
| 12 | Directing other coding agents | **Worker sessions** (§8.6): an agent uses `worker_start` to open an agent of some profile in an allowed directory, and results come back over the bus. A human can take over with `/attach` (chat, all providers) or `uniqlaw attach` (terminal: claude-tmux is live, claude-sdk / codex hand off to the native CLI's resume); during a takeover, the owner's messages are rejected. By default the only allowed directory is the project directory |
| 13 | Memory | **UniQlaw's own memory, shared by the whole instance** (§8.7): `memory/MEMORY.md` + daily notes + `DREAMS.md`, tools for every provider; Claude's auto-memory is turned off while it is on. Dreaming follows OpenClaw: rules pick candidates, the model only chooses add / merge / supersede / skip, and the written text is always the source entry, so the model can't write invented memory |

M0 results are in `docs/spikes/M0-results.md`. There are currently no open questions.

## 14. Milestones

| M | Scope | Acceptance |
|---|---|---|
| M0 | Spike: a 50-line PoC per adapter that maps events to `AgentEvent` (the PoC code is no longer in the tree; it is in git history). Must verify: (0) whether claude-tmux and claude-sdk can resume each other's session id; (1) whether the Claude SDK with `settingSources` / plugins loads the skills, plugins, hooks and plugin slash commands from `~/.claude`, compared against the TUI; (2) how subscription accounts are authorized under the SDK (check the SDK auth docs and terms, do not guess); (3) the queuing semantics of Claude streaming input; (4) the `turn/steer` parameters; (5) whether `agy` headless is officially supported; (6) how project trust is decided in pi SDK mode (whether `.pi/mcp.json` gets auto-denied, similar to v2's init-watch problem) | Capability matrix completed; every technical question listed in §13 answered |
| M1 ✅ | core (including multi-instance isolation: lock, runtime.json, tmux socket, token claims) + mcp-gateway + claude-common + **provider-claude-tmux** (v2 port, lowest risk) + platform-telegram + bus tools + v2 migration | A migrated v2 project runs on TG and behaves the same as v2 |
| M1.5 ✅ | provider-claude-sdk; mitigation of the Claude messaging socket risk; steer race (when a steer call and turn end happen at the same time, the reply is treated as background output and does not quote the original message); a real e2e of the permission denial path (so far only unit tests with a fake provider); automatic retries for typed errors | Passes the same contract tests as the tmux adapter (session interop verified in M0) |
| M2 🟡 | credentials package + provider-pi (direct APIs + Bedrock / Vertex / Azure) | Contract tests run once per credential type |
| M3 ✅ | provider-codex, provider-opencode, provider-acp (S5/S6/S6b to be re-verified once opencode's free quota recovers), provider-agy | Contract tests pass; polyfill rules take effect |
| M4 ✅ | transport-a2a (server + client; JSON-RPC / REST / gRPC) | Two uniqlaw instances `agent_ask` each other; third-party A2A agents can connect |
| M5 ✅ | discord / slack / line (only tested against fake servers), web dashboard, scheduler, model routing, migrate | Full feature parity with v2 |

**Status legend**: ✅ done and accepted; 🟡 partially done (see §15).

---

## 15. Implementation feedback (M1.5–M4, 2026-11-02)

### 15.1 Core additions
- `unsolicited_turn.source = "external"`: input that arrived through a provider-native channel (the Claude messaging socket). Core sends that turn (or the remainder of the turn) to the operator only, with a warning; claude-tmux emits it when it detects `<cross-session-message>`. This is the mitigation for the §5.2 messaging socket risk (the risk itself remains, see §5.2).
- Steer race: the origin of a steer within 3 seconds before turn end is carried over to the new turn the adapter falls back to opening, so the reply still goes to the person who steered.
- Typed errors: `rate_limit` retries automatically (up to 3 times, starting at 30 seconds and doubling each time); `usage_limit` informs the user and fails pending asks.
- Scheduling (`scheduler` package): cron on by default (v2 format, IANA timezones, optional catch-up), heartbeat (quiet hours, deferred when busy); scheduler plugins can contribute MCP tools (`cron_list` / `cron_save` / `cron_delete`).
- Model routing: v2's agentic modes + hysteresis, configured in `profile.options.agentic`; applies only to human turns, and only on providers with `modelSwitch: "live"`.
- `transport` plugin kind: remote agents appear in `agents_list` and can be asked directly with `agent_ask`; `runInbound` runs external A2A requests in an `a2a:<profile>:<contextId>` session of the specified profile.

### 15.2 Per-adapter test results
| adapter | Contract tests | Key findings |
|---|---|---|
| claude-tmux | 9/9 (real Claude) | Daemon stop uses `detach()` to keep tmux; permission denial ends the whole turn (core automatically adds a turn) |
| claude-sdk | 9/9 (S4 intermittent: haiku treats bare inserted text as prompt injection; what core actually sends carries a timestamp and source line) | Bidirectional session handover with claude-tmux ✅; **user-level allow rules (`~/.claude/settings.json`) let tools pass straight through, skipping UniQlaw approval**; setting `userSettings: false` on the profile excludes them; no `detach()`, so it re-runs `--resume` on restart |
| codex | 8/9 + dedicated isolation test (real app-server) | One app-server per credential set, one thread per session; **all settings are resent on every turn** (codex carries turn overrides forward); features such as `memories` can only be disabled with process-level `--disable`; **the built-in `collaboration.list_agents` / `send_message` cannot be removed**, but they only see subagents in the same thread (a dedicated test replaces S1b); the user's global codex MCP servers are loaded |
| pi | 9/9 (faux model) | Each session has its own model runtime carrying only that profile's credentials; `~/.agents/skills` is loaded (`skills: false` turns it off); **real models not yet verified (credentials needed)** |
| opencode | 9/9 (real opencode serve, free model) | One serve per session; config and data directories isolated under the instance; still loads `~/.claude/skills` and `~/.agents/skills` |
| acp (→ opencode acp) | 6/9 (S5/S6/S6b not verified because the free quota ran out) | One process per session by default; `session/load` replay suppression; when the quota runs out, opencode acp silently retries and hangs → the adapter reads the log and reports `usage_limit` within about 2 seconds |
| agy | 6 contract + 2 dedicated (real agy) | **Login cannot be isolated** (the token is in the system keyring and stays logged in even with a different `HOME`), so multiple instances share the same Google account; Vertex uses `AGY_ADC_AUTH`; `--remote-control` cannot do permission confirmation; MCP goes through a separate directory via `--add-dir` + `uniqlaw mcp-shim`, without writing into the user's project |
| transport-a2a | 14 + dual-daemon tests (JSON-RPC and gRPC) | JSON-RPC (default), REST (`/<profile>/rest`, self-written adapter layer) and gRPC (separate port, profiles distinguished by A2A `tenant`) are all supported, with consistent bearer token auth; every transport's port is written to `runtime.json` and shown by `uniqlaw status` |

### 15.3 M5 additions
- Core adds generic stall detection: if there is no provider event for `turn.stallTimeoutSec` (default 900 seconds), the turn is interrupted and the user is told; time spent waiting for manual approval does not count.
- Web dashboard (on the daemon's HTTP API, no build step): sessions + live transcript (core adds a `transcript` table, keeping the latest 500 entries per session), jobs, logs, SSE live events; non-loopback access requires `web.token`. Verified in a real browser.
- Discord / Slack / LINE: compatible with v2's channel key rules and settings format; empty `allowedUserIds` = deny all (v2 allowed all), and migration warns for every platform.

### 15.4 Second-round additions
- **Streaming output** (`output.stream: "replace"`): provider token deltas edit the same message live (first after 0.8 seconds, then at most once every 1.5 seconds); nothing is shown until there is enough text to rule out `NO_REPLY` / `HEARTBEAT_OK`, and `[react:…]` never appears in the live text; on interrupt, what has been shown is kept. Verified with real claude-sdk + the Telegram adapter.
- **Settings hot reload**: `uniqlaw reload` / `POST /api/reload` / `SIGHUP`; settings are validated first, and on failure the old settings stay in effect; on success it restarts within the same process, with provider sessions kept via `detach()`. Since 2026-11-11 it is graceful (§11.3).
- **Usability**: `uniqlaw init` (interactive wizard or `--yes`; stores only references to secrets; rejects empty allowlists), `uniqlaw doctor`, `uniqlaw logs`; README, `docs/INSTALL.md`; Claude Code plugin (`/uniqlaw:*` commands and the `uniqlaw-agents` skill).

### 15.5 API / SDK conformance checks (no real credentials needed)
- **Platforms**: each platform has `test/conformance.test.ts`, which validates outgoing requests and incoming payloads against official definitions (ajv + type checks, each with counterexamples). Telegram against `@grammyjs/types` (maintained by hand from the official docs); Discord REST against the official OpenAPI, Gateway against `discord-api-types`; Slack against `@slack/web-api` / `@slack/types` (the official OpenAPI is archived); LINE against the official line-openapi. Found and fixed: LINE's reaction API is not in the official spec (inherited from v2); removed, `reactions=false`.
- **pi credentials**: verified OpenAI / Anthropic / Gemini / Vertex / Bedrock (SigV4) / Azure against the pi-ai 1.4 source and by intercepting the HTTP requests actually sent. Fixes: Bedrock region and keys were not taking effect; OpenAI baseUrl / organization now use the fields pi-ai actually reads; what pi-ai cannot do (Azure Entra ID, AWS role, GCP impersonation) now raises an explicit error. Note: for values the profile does not set, pi-ai falls back to reading the daemon's environment variables.
- **agy credentials**: checked against agy's bundled changelog and help: API key → `GEMINI_API_KEY`; ADC → `AGY_ADC_AUTH=1` + `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `GOOGLE_APPLICATION_CREDENTIALS`; removed variables with no documented basis.
- **Still needs real credentials to verify**: actual token exchange and model responses, whether agy accepts the value `AGY_ADC_AUTH=1`, and end-to-end tests of each platform against the real services.

### 15.6 To do
- pi real-model verification (needs one of: OpenAI key / Vertex ADC / Bedrock / Azure).
- Re-verify ACP S5/S6/S6b (once opencode's free quota recovers): `UNIQLAW_E2E=1 bun test packages/provider-acp/test/contract.e2e.test.ts -t "S5|S6"`.
- End-to-end verification of Discord / Slack / LINE against the real services (needs test bots).
- Real tests of agy API key and ADC.


---

## 16. Planned (OpenClaw comparison, 2026-11-10)

Done in this round: group modes (`groups`, `/activation`), DM pairing (`pairing`, `/pair`, `uniqlaw pairing`), `send_file`, optional voice transcription (`transcription`, plugins `whisper` / `transcribe-api`).

**Pre-compaction memory flush** (OpenClaw: a silent "write memory now" turn just below the auto-compaction threshold). Needs `Usage` to carry `contextTokens` / `contextWindow`. What each provider can report:

| provider | context in use | window |
|---|---|---|
| claude-sdk | `query.getContextUsage({ detail: "summary" })` → `total_tokens`, `raw_max_tokens` (= the autocompact window) | exact |
| claude-tmux | statusLine command JSON `context_window` (Claude Code ≥ 2.1.6; we already pass `--settings`), or the last assistant entry's usage in the session jsonl (input + cache read + cache creation) | `context_window.context_window_size` |
| codex | `ThreadTokenUsageUpdated` → `last` | `modelContextWindow` |
| acp | `session/update` `usage_update` (`used`, `size`; stable since 2026-06), when the agent sends it | same |
| opencode | per-message `tokens` (input + cache) | model `limit.context` from the provider list |
| pi | per-message usage | `model.contextWindow` |
| agy | per-turn `input_tokens` only | unknown (model table) |

The flush itself is a scheduler-style silent turn (`silent` origin, `NO_REPLY`) asking the agent to `memory_write`, once per compaction cycle, triggered when `contextTokens > window − softThreshold`.

**Failover across providers** — implemented (2026-11-10): owner is asked, others get the error; `/profile`; raw-transcript handoff; switching back resumes the earlier session with a "meanwhile" block. Original notes: trigger on `usage_limit` (rate limits are already retried). Profile option `fallback: [profile…]`; the channel runs on the fallback until the primary is usable again. Continuity: claude-tmux ↔ claude-sdk share session files natively; otherwise the new session's first turn gets a handoff block built from the provider-neutral `TranscriptStore` (last N turns, capped in tokens), and when the channel returns to the primary, its still-resumable native session gets a "meanwhile" block with the turns that ran elsewhere.

**TODO**
- Semantic memory search (embeddings / hybrid with the current substring search; OpenClaw: LanceDB, Active Memory).
- Hooks (user handlers on message / `/new` / startup events), inbound webhooks mapped to sessions, and a control UI (settings, pairing, groups, jobs) — the web dashboard is the natural place.
- Voice replies (TTS) on top of `send_file`.
