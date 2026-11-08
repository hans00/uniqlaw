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

## Not vulnerabilities by themselves

- What an agent does after a human approved it, or under a permission level you configured (e.g. `unrestricted` with `approval.mode: "auto-allow"`).
- Behavior of the underlying agent CLIs or model providers. Report those upstream.

## Defaults worth knowing

- `allowedUserIds` is required on every platform; an empty list means nobody can talk to the bot.
- The web dashboard and MCP gateway bind to `127.0.0.1`. A non-loopback web host requires `web.token`; non-loopback A2A exposure requires bearer tokens.
- Settings store only references to secrets (env var, file, or command), never the values.
- Provider child processes get a minimal environment plus their own profile's credential.
