---
description: Make a session answer its own chat (its agent runs a turn; the reply goes to that chat)
---

Parse `$ARGUMENTS` as `<target> <prompt…>` (target = a session/channel key such as `telegram:-100123`, `discord:<id>`, `global`). Run:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts trigger --project "$PWD" '<target>' '<prompt>'
```
If you only need an answer for yourself (no human should see it), use the `agent_ask` MCP tool instead (see the uniqlaw-agents skill).
