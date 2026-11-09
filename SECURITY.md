# Security policy

UniQlaw runs coding agents that can execute commands on your machine, driven by chat messages. Please report security problems privately.

## Reporting

Use GitHub's **private vulnerability reporting** (Security tab → "Report a vulnerability") on this repository. Please do not open a public issue for vulnerabilities. Include the version or commit, your settings (with secrets removed), and steps to reproduce.

## What counts

Examples of what we treat as vulnerabilities:

- A chat user not in `allowedUserIds` getting a reply, running a turn, or answering an approval prompt.
- One session acting as another through the bus or MCP gateway (identity comes from each session's own gateway token).
- A worker running outside `workers.roots`, or with a profile not in `workers.profiles`.
- Secrets showing up in logs, chat output, `uniqlaw doctor`, the web dashboard, or a provider's environment that shouldn't get them.
- The web dashboard / HTTP API or A2A endpoint reachable without a token on a non-loopback address.
- Text from a group chat, a background job (heartbeat, cron), a worker or a remote agent ending up in `memory/MEMORY.md` through the dreaming sweep, or text that no one wrote in a daily note (MEMORY.md lines must be copies of existing notes).
- `memory_get` / `memory_search` reading files outside the memory directory, or the `dream` session writing memory.

## Not vulnerabilities by themselves

- What an agent does after a human approved it, or under a permission level you configured (e.g. `unrestricted` with `approval.mode: "auto-allow"`).
- Behavior of the underlying agent CLIs or model providers. Report those upstream.

## Defaults worth knowing

- `allowedUserIds` is required on every platform; an empty list means nobody can talk to the bot.
- The web dashboard and MCP gateway bind to `127.0.0.1`. A non-loopback web host requires `web.token`; non-loopback A2A exposure requires bearer tokens.
- Settings store only references to secrets (env var, file, or command), never the values.
- Provider child processes get a minimal environment plus their own profile's credential.
- `memory/MEMORY.md` is part of every chat's system prompt. Only notes from one-to-one chats with allowed users (or files you edit yourself) can be promoted into it; anything an agent was told in a group chat stays in the searchable daily notes only.
