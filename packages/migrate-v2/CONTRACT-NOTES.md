# migrate-v2: notes for core, the CLI, and the claude-tmux adapter

`@uniqlaw/migrate-v2` writes only through the public core API (`parseSettings`, `StateStore`). It needed no core changes. The items below affect other packages.

## For core

1. **The `pending_input` payload for migrated inbox entries** has `kind: "external"` and this payload:
   `{ source: "v2-inbox", ts?, kind?: "send"|"trigger-result"|"external", from?, text, note? }`.
   The core's pending-input prompt formatter should render it the way v2's `formatInboxForPrompt` did.
2. **`timezone`** is copied verbatim. v2 used offsets like `"UTC+8"`, and the real install uses that format. The schema accepts any string. Either the scheduler (M5) parses `UTC±N`, or core validates IANA names and accepts the offset form as well.
3. **`profiles.main.options.agentic`** holds the raw v2 `agentic` block (modes, hysteresis). The M5 model router should read it from there or migrate it into its own schema.
4. **`plugins.heartbeat`** is written with `enabled: false` and `v2Enabled: <original>`. The scheduler plugin should honour `v2Enabled` as a hint on first run, or the CLI should ask whether to turn it on.

## For the claude-tmux adapter

5. **`SessionRow.adapterState`** is `{"v2TmuxSession": "claudeclaw-<hash>-<key>"}`. v2 tmux sessions live on the **default** tmux socket, not the instance socket (`-L uniqlaw-<id>`). On first open the adapter should do one of two things:
   - check `tmux has-session -t <v2TmuxSession>` on the default socket and kill it, since v2 must be stopped first, then spawn on the instance socket with `--resume <providerSessionId>`; or
   - attach to it once and record the new name.

   Killing it and resuming is simpler and safe: the history lives in the jsonl.
6. `providerSessionId` is the v2 Claude session uuid. Locate the jsonl by globbing for the id (`~/.claude/projects/*/<id>.jsonl`), not by the cwd hash (M0 finding). A migrated project may now live in a different cwd.

## For the CLI (`uniqlaw migrate`)

7. Call `detectRunningV2(v2Dir)` first. If `running`, refuse and tell the user to stop v2 (`kill -TERM <pid>` or `/claudeclaw2:stop`).
8. Flow: `planMigration` → print the plan and warnings → `applyMigration(plan, target, { dryRun })` → print the report. `--force` maps to `{ force: true }` and overwrites a `settings.json` the user edited after an earlier migration.
9. The real install at `~/claudeclaw` also has the v1-era keys `api`, `fallback` and `sessionTimeoutMs`, and a v1 `session.json`. Both are reported as warnings only.
