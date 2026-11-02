---
description: Show UniQlaw daemon status and sessions
---

Run `bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts status --project "$PWD"`. Summarise: daemon pid/ports, each session (profile/provider, state, queue). If the daemon is not running, say so and suggest `/uniqlaw:start`.
