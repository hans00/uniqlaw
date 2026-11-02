---
description: Start the UniQlaw daemon for this project
---

1. If `pwd` equals `$HOME`, STOP and ask the user to `cd` into the project.
2. Run `bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts start --project "$PWD"` and report the pid and ports it prints.
3. If it fails, run `bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts logs --project "$PWD" --lines 40` and `bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts doctor --project "$PWD"` and explain the problem.
