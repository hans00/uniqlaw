---
description: Post a message you wrote to a chat target (a human sees it verbatim)
---

Parse `$ARGUMENTS` as `<target> <message…>`. Targets: `telegram:<chatId>`, `discord:<channelId>`, `slack:<channelId>[:<threadTs>]`, `line:<id>`.

This sends a real message — confirm sensitive content with the user first. Then run:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts send --project "$PWD" '<target>' '<message>'
```
The session that owns that chat gets an echo so it knows the message was sent.
