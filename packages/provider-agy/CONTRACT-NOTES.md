# provider-agy notes (M3)

Antigravity CLI 1.4.12, official headless mode: `agy --input-format stream-json --output-format stream-json -p=`.
No core changes needed.

## Design

- **One process per session**, spawned eagerly in `open()`: agy prints `init` (conversation id) before any input, so `session` is emitted immediately. `providerSessionId` = conversation id; resume = `--conversation <id>`.
- **Interrupt** = `SIGINT` → agy reports `result{finished_reason:"interrupted"}` and exits → the dying process is dropped at once and the next `send()` respawns with `--conversation` (writing into the dying process was a real race, fixed).
- **Model switch** = `"spawn"`: `setModel()` emits `model`, then restarts the process with `--model` + `--conversation` (after the turn if one is running). History is kept (e2e).
- **steer = false**: a second stdin line is queued as its own turn; core uses its own queue.
- **System prompt**: agy has no system-prompt flag. Fragments are prefixed to the first turn of a NEW conversation inside `<system-instructions>`; resumed conversations already carry them.

## Permissions (no callback)

`control_request` on stdin is "not supported yet", so agy cannot ask an operator. `PermissionPolicy` → `--settings {"permissions":{"allow":[…],"deny":[…]}}`:
- `mcp(uniqlaw/*)` is always allowed (bus tools).
- `allowTools`: `Bash` → `command(*)`, `Bash(cmd)` → `command(cmd)` (agy matches exact commands or `*` only — no prefix globs), `Read/Glob/Grep` → `read_file(*)`, `Write/Edit` → `write_file(*)`, `WebFetch` → `url(*)`; raw agy rules pass through; others are reported as unmapped.
- `approval.mode: auto-allow` → `--dangerously-skip-permissions`; `level: locked` → `--mode plan`; `level: strict` → deny `command(*)` + `url(*)`.
- Everything else is auto-denied by agy. `result.denied_actions` is surfaced as `tool_end{ok:false, summary:"blocked by policy: …"}` plus a text note telling the operator which rule to add.

## MCP (bus tools)

agy loads MCP servers from `~/.gemini/config/mcp_config.json`, plugins, or a workspace `.agents/mcp_config.json`. Verified: **workspace dirs added with `--add-dir` count** (control run without it: server absent). So each session gets `<stateDir>/agy-workspaces/<instance>/<session>/.agents/mcp_config.json` → `uniqlaw mcp-shim` (stdio), added via `--add-dir`; agy still runs in the user's project cwd and **the project is never written to**. The dir is removed on `close()`. Identity: the shim reads `UNIQLAW_MCP_URL` / `UNIQLAW_TOKEN` from the env agy passes down → S6 and S6b (cross-session isolation) pass.
Side effect (agy, not us): tool schemas are cached under `~/.gemini/antigravity-cli/mcp/<server>/`.

`shimCommand` defaults to `[bun, <monorepo>/packages/cli/src/main.ts, "mcp-shim"]`; set it in the plugin config for other layouts.

## Credentials

- `gemini-api-key` → `GEMINI_API_KEY` (documented in agy's changelog; not tested here — no key on this machine).
- `gcp` → `AGY_ADC_AUTH=1` + `GOOGLE_CLOUD_PROJECT/LOCATION` + `GOOGLE_APPLICATION_CREDENTIALS`. agy's documented ADC sign-in is `AGY_ADC_AUTH` (Business / GCP project), **not** `GOOGLE_GENAI_USE_VERTEXAI`. The exact value agy expects is undocumented; **untested**.
- `provider-login` → `HOME=<home>`. **Finding: HOME does not isolate the account.** With an empty `HOME` agy still signed in (token is in the user keyring); a separate HOME only isolates config, MCP cache and conversations. No dedicated config-dir env exists (`ANTIGRAVITY_EXECUTABLE_DATA_DIR` is a plugin-sidecar data var; `--app_data_dir` is internal). Plugin option `isolateHome: true` gives each instance its own HOME under `stateDir/agy-home/<instance>`.
- Errors: stderr `AGY_ERROR: {…}` (exit 3) → `turn_end.error` `rate_limit` / `usage_limit` / `auth`.

## `--remote-control`

A session-scoped tunnel so the user can follow/control the terminal session from another device (Remote Control web/mobile UI); not supported with ADC. It is not a local programmatic API and offers no permission callback for a daemon → not usable for UniQlaw approvals.

## Contract results (real agy, gemini-3.8-flash-low)

S1, S1b, S3, S5, S6, S6b pass for real. S2, S4, S7 return early by capability (no callback / no steer / spawn switch) — replaced by `agy.e2e.test.ts`: pre-allowed command runs + non-allowed command auto-denied and surfaced; `setModel` respawn keeps history. Both pass.

## Credential mapping — conformance with agy 1.4.12's own documentation (2026-11-02)

Verified against agy's bundled changelog (`~/.gemini/antigravity-cli/cache/CHANGELOG.md`) and the help/error text embedded in the binary. No real login was attempted and Google was never called.

**Gemini API key** (`gemini-api-key` → `GEMINI_API_KEY`)
- Changelog: "connect with a `GEMINI_API_KEY`"; "`GEMINI_API_KEY` sessions …"; the binary contains `AUTH_MODE_GEMINI_API_KEY`.
- Binary: "Warning: Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY." → the adapter never passes `GOOGLE_API_KEY`, and strips it (plus `AGY_ADC_AUTH`) in API-key mode.

**ADC / Vertex ("Agent Platform")** (`gcp` → `AGY_ADC_AUTH=1`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`)
- Changelog: "Added sign-in with Application Default Credentials so you can use Agent Platform." / "sign in with Application Default Credentials (`AGY_ADC_AUTH`)".
- Binary: "To log out, please run `unset AGY_ADC_AUTH` in your terminal and restart the CLI." → presence turns ADC sign-in on (we set `1`).
- Binary: "A project and location from %s and %s or from settings.json gcp.project and gcp.location (with Application Default Credentials) must be set for Agent Platform authentication." The binary's only standalone project/location env constants are `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` (no `GOOGLE_CLOUD_REGION`).
- Binary sign-in help: "1. Run: gcloud auth application-default login" / "2. Or check GOOGLE_APPLICATION_CREDENTIALS env var." / "3. Or unset AGY_ADC_AUTH env var to use other sign in methods."
- `GOOGLE_GENAI_USE_VERTEXAI` is **not** part of agy's documented flow and is no longer set.
- The isolated `HOME` would hide `~/.config/gcloud/application_default_credentials.json`, so when no file is configured the adapter sets `GOOGLE_APPLICATION_CREDENTIALS` to the user's real default ADC path (the path only; the file is never read).
- Service-account impersonation isn't documented for agy → `gcp.impersonate` is rejected with guidance (use an impersonated ADC file).

**Not verifiable without a real credential:** that agy accepts `AGY_ADC_AUTH=1` specifically (versus requiring other values), the end-to-end ADC token flow, and Gemini API key sessions.
