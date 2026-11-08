---
description: Migrate a ClaudeClaw v2 project to UniQlaw (agent-guided, plan first)
---

Read `${CLAUDE_PLUGIN_ROOT}/docs/MIGRATE.md` and carry out the migration for the v2 project in `$PWD` (or the directory the user names) by following it. There is no migrate script: read the actual v2 files and map them with the tables in that guide.

1. Read the v2 files (read-only; this is fine while v2 runs). Show the user a plan: the settings you will write, sessions to import, jobs and prompts to copy, and every key you will drop. Never print token or secret values.
2. Stop and ask about anything the guide marks as a user decision: empty `allowedUserIds` (UniQlaw denies everyone on an empty list), `skipPermissions` / auto-allow, timezone format, inbox entries, heartbeat, overwriting an existing `.uniqlaw/settings.json`.
3. Before writing anything, make sure v2 is stopped (`/claudeclaw2:stop`). v2 and UniQlaw must never poll the same bot token at once.
4. Write `.uniqlaw/` and validate settings as the guide describes. Then run `/uniqlaw:doctor`, and `/uniqlaw:start` once the user agrees.
5. Report what was migrated, what was skipped and why, and what the user still needs to do.
