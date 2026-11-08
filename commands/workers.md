---
description: List, start or stop worker sessions (other coding agents working in a directory), and show how to take one over
---

Parse `$ARGUMENTS`:
- empty → list workers:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts workers --project "$PWD"
  ```
- `start <name> <profile> <dir> [task…]` →
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts worker start '<name>' --profile '<profile>' --cwd '<dir>' --project "$PWD" '<task…>'
  ```
- `stop <name> [--forget]` →
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts worker stop '<name>' --project "$PWD" [--forget]
  ```

The directory must be inside `workers.roots` in `.uniqlaw/settings.json` (default: the project directory only); say so if the start is refused.

Taking a worker over is interactive, so don't run it here. Tell the user to run `uniqlaw attach <name>` in their own terminal (claude-tmux: live tmux attach, detach with Ctrl-b d; claude-sdk / codex: opens the agent's own CLI on the same conversation and hands it back on exit), or to send `/attach <name>` from their chat (`/detach` to return).
