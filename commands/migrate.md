---
description: Migrate a ClaudeClaw v2 project to UniQlaw (dry-run first)
---

Follow `${CLAUDE_PLUGIN_ROOT}/docs/MIGRATE.md`:
1. Dry run (read-only, fine while v2 runs): `bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts migrate --from "$PWD" --project "$PWD" --dry-run`. Summarise counts and warnings; never print token values.
2. Ask the user to stop v2 (`/claudeclaw2:stop`). v2 and UniQlaw must never poll the same bot token at once.
3. Apply: `bun ${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts migrate --from "$PWD" --project "$PWD"`.
4. Check `.uniqlaw/settings.json`: non-empty allowedUserIds per platform; suggest moving inline tokens to `{"env": "…"}`.
5. `/uniqlaw:doctor`, then `/uniqlaw:start`.
