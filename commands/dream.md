---
description: Run or preview the memory consolidation sweep (dreaming) that promotes daily notes into memory/MEMORY.md
---

Parse `$ARGUMENTS`:
- empty or `preview` / `dry-run` → explain what tonight's sweep would promote, without a model call or any write:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts dream --dry-run --project "$PWD"
  ```
- `run` / `now` → run a full sweep now (one or two model turns; writes `memory/MEMORY.md` and `memory/DREAMS.md`):
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts dream --project "$PWD"
  ```

Summarise the result: candidates and the gate each passed, what was added / merged / superseded / skipped, any fallback reason, and the diary entry. If the run is refused because dreaming is not enabled, show the user the settings to add (`"plugins": { "dreaming": { "profile": "<profile>" } }`, ideally a profile with `"permissions": { "level": "locked" }`) and don't edit settings.json without their OK.
