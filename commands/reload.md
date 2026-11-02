---
description: Reload .uniqlaw/settings.json without restarting (invalid settings are refused; the running config stays)
---

Run `bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts reload --project "$PWD"`. If it prints "reload refused", show the validation errors and help fix settings.json.
