# provider-codex: notes and contract requests

Implements `AgentProvider` for `codex app-server` (codex-cli 0.166.0, stdio JSON-RPC). Protocol types are generated: `codex app-server generate-ts --experimental --out src/protocol`.

## Results

Real run with gpt-6-luna at effort low (`UNIQLAW_E2E=1`):
- **Contract suite:** S1, S2 (allow and deny), S3, S4 (true single-turn steer), S5, S6, S6b (two threads in one process, isolated MCP tokens) and S7 pass. S1b is skipped (see below).
- **`test/isolation.e2e.test.ts`:** passes.
- **Unit tests:** 6/6 pass.

## Design

- **Process model:**
  - Processes are pooled by (codexPath, args, env). One `codex app-server` process hosts one thread per UniQlaw session.
  - Sessions with different credentials get different processes.
  - An idle process is killed after `idleKillMs`.
- **Per-turn overrides are sticky in codex.** Every `turn/start` therefore re-sends model, effort, approvalPolicy, sandboxPolicy and cwd.
- **Permissions:**
  - ask-operator and auto-deny map to `approvalPolicy: "untrusted"`; core answers the approval, or auto-denies. auto-allow maps to `"never"`.
  - Sandbox by level: locked → read-only, strict → workspace-write without network, moderate → workspace-write with network, unrestricted → danger-full-access.
  - Approving a command does not escalate the sandbox.
- **Disabled features:** `memories`, `agent_message_board`, `wake_on_agent_messages` and `send_message_to_user_async` are turned off with `--disable` at process level, plus per-thread config. **Feature flags only take effect at process level.** The per-thread `config.features` values are ignored.
- **Credentials:**
  - `openai-api-key`, `openai-compatible` and `azure` (api-key only) become a dedicated `model_providers.uniqlaw` with its own `env_key`, so `~/.codex/auth.json` and the user's ChatGPT login are never touched. Azure with Entra ID auth is rejected.
  - `provider-login` sets `CODEX_HOME`. Other kinds throw an error.
  - None of these credential paths were exercised against a real key. Only the logged-in ChatGPT path was tested.
- **Env:** the adapter adds PATH, HOME, LANG, USER and TMPDIR from the daemon when `spec.env` lacks them, the same as claude-tmux.

## Contract requests

1. **S1b is Claude-specific.** It asks about tools named `ListAgents` and `SendMessage`. Codex 0.166 always exposes `collaboration.list_agents`, `send_message`, `spawn_agent` and related tools, so S1b fails literally. These tools cannot be disabled: `--disable multi_agent` / `multi_agent_v2` and `multiAgentMode` have no effect. `isolation.e2e.test.ts` shows that `list_agents` only sees the thread's own tree (`/root`) even with a sibling UniQlaw thread in the same process. That makes them session-internal, which architecture §8.1 allows. Proposal: let `runProviderContract` take a provider-supplied "native cross-session probe" in place of the hard-coded tool names.
2. **The user's global codex MCP servers** from `~/.codex/config.toml` (here `cua_repl`) are loaded into UniQlaw threads, the same as user MCP for Claude. If that is unwanted, use a profile with a `provider-login` credential pointing at a separate `CODEX_HOME`.
3. **`detach()` is not implemented.** Threads persist in CODEX_HOME, so after a daemon restart `open()` with `providerSessionId` calls `thread/resume`, which is cheap. Daemon shutdown therefore uses `close()`, which interrupts an active turn first.
