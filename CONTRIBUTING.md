# Contributing

Thanks for helping. Bug reports, provider/platform adapters, and doc fixes are all welcome.

## Setup

```bash
git clone https://github.com/hans00/uniqlaw.git && cd uniqlaw
bun install          # Bun >= 1.3
bun run typecheck    # tsc --noEmit for every package
bun run test         # unit + contract tests with fake providers and platforms
```

`bun test` inside a single package runs only that package. CI runs the same three commands.

## End-to-end tests

Tests that drive real agent CLIs (`claude`, `codex`, `opencode`, `agy`) or real model APIs are skipped unless `UNIQLAW_E2E=1`. They spend quota and need you to be logged in, so run them only for the adapters you touched:

```bash
UNIQLAW_E2E=1 bun test packages/provider-codex
```

Rules for any test or manual check:

- Never point a test at a real bot token that another process is also polling. Two pollers on one Telegram/Discord/Slack token steal each other's updates; this includes a running ClaudeClaw v2 or a second UniQlaw instance.
- Tests must not read or modify your real home directory (`~/.claude`, `~/.codex`, `~/.gemini`, …). Use a temp dir.
- Never print secrets. Credentials in settings are references (`{"env": …}`, `{"file": …}`, `{"command": …}`), never literal values.

## Layout and where to start

- `packages/core`: plugin contracts (`plugin.ts`, `provider.ts`, `platform.ts`), the session runtime, the message bus and the MCP gateway.
- `packages/provider-*`, `packages/platform-*`, `packages/scheduler`, `packages/transport-a2a`: plugins.
- `packages/testkit`: mock provider/platform and `runProviderContract`, the shared scenario suite every provider runs.
- `docs/architecture.md`: the design. §3 (plugins), §5 (provider interface) and §6 (capability polyfill) are the ones to read before writing an adapter.

### Adding a provider

1. Implement `AgentProvider` (`packages/core/src/provider.ts`) and declare capabilities honestly. Core fills in what you can't do (e.g. queues at turn boundaries if you can't steer); a capability you declare but don't really support is a bug.
2. Run `runProviderContract` from `@uniqlaw/testkit` against it (real backend behind `UNIQLAW_E2E=1`).
3. Write down protocol quirks and anything you need from core in the package's `CONTRACT-NOTES.md`.

### Adding a platform

Implement `PlatformAdapter` (`packages/core/src/platform.ts`), require `allowedUserIds`, and test against a local fake of the platform API (see the existing `platform-*` tests). Don't hit the real service in unit tests.

## Pull requests

- Keep changes focused; add or update tests with behavior changes.
- `bun run typecheck` and `bun run test` must pass.
- Commit messages: `type(scope): summary`, e.g. `fix(provider-codex): …`, `feat(core): …`, `docs: …`.
- Update `README.md` / `docs/` when you change user-facing behavior or settings.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
