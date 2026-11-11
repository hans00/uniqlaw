#!/usr/bin/env bun
// uniqlaw CLI: init | doctor | start | stop | reload | restart | status | logs | ls | send | trigger | workers | worker | attach | run | mcp-shim
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findProjectDir } from "./project.ts";
import { isAlive, listInstances, loadSettings, readRuntime, runForever, stateDirOf } from "@uniqlaw/daemon";
import { resolveSecret, type DreamReport, type SecretRef } from "@uniqlaw/core";
import { PLATFORM_SECRETS, PLATFORMS } from "./init.ts";

const USAGE = `uniqlaw <command> [options]

  init     [--project DIR] [--yes …] [--force]   create .uniqlaw/settings.json (interactive wizard)
  doctor   [--project DIR]                     check tools, settings, credentials, ports, bot tokens
  logs     [--project DIR] [--lines N]         tail the daemon log
  run      [--project DIR]                     run the daemon in the foreground
  start    [--project DIR]                     start the daemon in the background
  stop     [--project DIR]                     stop the daemon
  reload   [--project DIR] [--reason R] [--now] re-read settings.json, gracefully (rejected if invalid; old config keeps running)
  restart  [--project DIR] [--reason R] [--in DUR | --at TIME] [--now] [--cancel]
                                               restart the daemon process (new code + settings), gracefully: returns at once,
                                               running turns finish first (restart.drainTimeoutSec), new messages wait and
                                               are replayed; the asking session gets a notice when it is back.
                                               --in 90s|10m|1h30m, --at HH:MM|ISO; --now: don't wait for running turns;
                                               --from SESSION names the asking session (default: $UNIQLAW_SESSION)
  status   [--project DIR]                     show daemon + session status
  ls                                           list UniQlaw instances on this machine
  send     <target> <text...> [--project DIR]  post text to a chat (e.g. telegram:<chatId>)
  trigger  <target> <prompt...> [--project DIR] make a session answer its own chat
  pairing  [list|approve <code>|deny <code>|revoke <platform> <userId>]  DM pairing requests and paired users
  workers  [--project DIR]                     list worker sessions (other coding agents started by sessions)
  worker   start <name> --profile P [--cwd DIR] [task...]   start a worker (and hand it a task)
  worker   stop <name> [--forget]              stop a worker (--forget also drops its conversation)
  attach   <worker|session> [--project DIR]    take over a session in this terminal (claude-tmux: live;
                                               claude-sdk/codex: resumed in their own CLI, handed back on exit)
  release  <worker|session> [--project DIR]   end a terminal takeover that didn't hand back (closed terminal, crash)
  dream    [--dry-run] [--json] [--project DIR] run the memory consolidation sweep now (--dry-run: rank and explain only)
  mcp-shim                                     stdio⇄HTTP MCP bridge to the gateway (env UNIQLAW_MCP_URL, UNIQLAW_TOKEN)
`;

const BOOL_FLAGS = new Set(["help", "now", "cancel", "graceful", "dry-run", "forget", "force", "json", "yes", "no-web", "heartbeat", "allow-empty", "telegram", "discord", "slack", "line"]);

const INIT_HELP = `uniqlaw init [--project DIR] [--force]                       interactive setup wizard
uniqlaw init --yes [options]                                   non-interactive (for scripts)

  --provider claude-tmux|claude-sdk|codex|opencode|agy|pi   --model M
  --credential KIND   (+ --key REF --base-url U --region R --aws-profile P --gcp-project P
                       --location L --service-account FILE --endpoint U --deployment D)
  --<platform>        enable telegram|discord|slack|line with default env var names
  --<platform>-users ID,ID            allowlist (required unless --allow-empty)
  --telegram-token REF  --discord-token REF  --slack-bot-token REF  --slack-app-token REF
  --line-channel-access-token REF  --line-channel-secret REF
  --no-web  --heartbeat  --force

REF = ENV_VAR | env:VAR | file:/path | cmd:<command>. Secrets are never stored inline.
An empty platform allowlist is refused unless --allow-empty is given.`;

/** The --flags each command accepts (--help and --project are accepted everywhere). Anything else is an error:
 *  a typo must not be silently ignored by a command that changes things. */
const COMMAND_FLAGS: Record<string, string[]> = {
  init: ["yes", "force", "provider", "model", "credential", "key", "base-url", "region", "aws-profile", "gcp-project",
    "location", "service-account", "endpoint", "deployment", "allow-empty", "no-web", "heartbeat",
    ...PLATFORMS.flatMap((p) => [p, `${p}-users`, ...Object.keys(PLATFORM_SECRETS[p]).map((k) => `${p}-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)])],
  doctor: [], logs: ["lines"], run: [], start: [], stop: [],
  reload: ["reason", "now", "cancel", "from", "json", "in", "at", "graceful"],
  restart: ["reason", "now", "cancel", "from", "json", "in", "at", "graceful"],
  status: [], ls: [], send: [], trigger: [], pairing: [], workers: [],
  worker: ["profile", "cwd", "forget"], attach: [], release: [], dream: ["dry-run", "json"], "mcp-shim": [],
};

/** A command's lines from USAGE (with its continuation lines), or init's own longer help. */
export function usageFor(cmd: string): string {
  if (cmd === "init") return INIT_HELP;
  const lines = USAGE.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith(`  ${cmd} `)) continue;
    out.push(`uniqlaw ${lines[i]!.slice(2)}`);
    while (i + 1 < lines.length && /^ {20,}\S/.test(lines[i + 1]!)) out.push(lines[++i]!);
  }
  return out.length ? out.join("\n") : USAGE;
}

/** Argument parsing. Everything after a bare `--` is positional (to send text that looks like a flag). */
export function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !BOOL_FLAGS.has(k)) { flags[k] = next; i++; }
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

/** `--help` / `-h` anywhere before a bare `--`. Checked before anything else runs. */
export function wantsHelp(args: string[]): boolean {
  const dd = args.indexOf("--");
  return (dd < 0 ? args : args.slice(0, dd)).some((a) => a === "--help" || a === "-h");
}

async function api(projectDir: string, path: string, body?: unknown) {
  const rt = readRuntime(projectDir);
  if (!rt || !isAlive(rt.pid)) throw new Error(`daemon is not running for ${projectDir}`);
  if (!rt.webPort) throw new Error("daemon has the HTTP API disabled (web.enabled=false)");
  // web.token protects the API; the CLI must present it too.
  const ref = loadSettings(projectDir).web.token;
  const auth: Record<string, string> = ref ? { authorization: `Bearer ${await resolveSecret(ref as SecretRef)}` } : {};
  const res = await fetch(`http://127.0.0.1:${rt.webPort}${path}`, body === undefined ? { headers: auth } : {
    method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // Help first: no daemon contact, no file writes, no side effects of any kind.
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    const topic = cmd === "help" ? rest[0] : undefined;
    console.log(topic && topic in COMMAND_FLAGS ? usageFor(topic) : USAGE);
    return;
  }
  if (!(cmd in COMMAND_FLAGS)) { console.error(`unknown command "${cmd}"\n\n${USAGE}`); process.exit(1); }
  if (wantsHelp(rest)) { console.log(usageFor(cmd)); return; }
  const { flags, pos } = parse(rest);
  const allowed = new Set(["project", ...COMMAND_FLAGS[cmd]!]);
  const unknown = Object.keys(flags).filter((k) => !allowed.has(k));
  if (unknown.length) {
    console.error(`unknown option${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `--${k}`).join(", ")} for \`uniqlaw ${cmd}\`\n\n${usageFor(cmd)}`);
    process.exit(2);
  }
  const projectDir = flags.project !== undefined ? resolve(String(flags.project)) : cmd === "init" ? process.cwd() : findProjectDir(process.cwd());

  switch (cmd) {
    case "init": {
      const init = await import("./init.ts");
      const available = init.detectProviders();
      if (init.hasV2(projectDir) && !flags.force) {
        console.log(`Found ClaudeClaw v2 config in ${projectDir}.
To carry it over instead, have your agent follow docs/MIGRATE.md (in Claude Code: /uniqlaw:migrate).
`);
      }
      let answers;
      if (flags.yes) answers = init.answersFromFlags(flags, available);
      else {
        const r = new init.LineReader(process.stdin);
        if (init.hasV2(projectDir) && !await r.yesNo("Set up a fresh UniQlaw config anyway (v2 files are not touched)?", false)) process.exit(0);
        answers = await init.interactiveAnswers(r, available);
      }
      const res = init.writeSettings(projectDir, answers, { force: !!flags.force });
      console.log(`wrote ${res.settingsPath}`);
      for (const c of res.created) console.log(`created ${c}`);
      for (const w of res.warnings) console.log(`warning: ${w}`);
      console.log("next: uniqlaw doctor && uniqlaw start");
      process.exit(0);
    }
    case "doctor": {
      const { runDoctor, formatChecks } = await import("./doctor.ts");
      const checks = await runDoctor(projectDir);
      console.log(formatChecks(checks));
      process.exit(checks.some((c) => c.level === "fail") ? 1 : 0);
    }
    case "logs": {
      const p = join(stateDirOf(projectDir), "logs", "daemon.log");
      if (!existsSync(p)) { console.log(`no log at ${p}`); return; }
      const n = Number(flags.lines ?? 50);
      console.log(readFileSync(p, "utf8").trimEnd().split("\n").slice(-n).join("\n"));
      return;
    }
    case "run": {
      // SIGHUP = hot reload, SIGTERM/SIGINT = shutdown (handled by runForever).
      await runForever(projectDir, { logToStderr: true });
      return;
    }
    case "reload":
    case "restart": {
      // Validate here too and report a broken settings.json instead of silently keeping the old config.
      // The request returns at once: an agent running this in its own turn must be able to finish that turn.
      if (!flags.cancel) {
        try { loadSettings(projectDir); } catch (e) {
          console.error(`${cmd} refused — settings.json is invalid, the running daemon is unchanged:\n${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
      }
      if (cmd === "reload" && (flags.in || flags.at)) throw new Error("--in / --at are for restart; reload runs right away");
      const from = typeof flags.from === "string" ? flags.from : process.env.UNIQLAW_SESSION || "cli";
      // Proof that we speak for that session (the daemon only trusts a session name with it or web.token): its
      // gateway token, readable only by the daemon's user.
      let fromToken: string | undefined;
      try { fromToken = (JSON.parse(readFileSync(join(stateDirOf(projectDir), "gateway.json"), "utf8")) as { tokens?: Record<string, string> }).tokens?.[from]; } catch {}
      const r = await api(projectDir, `/api/${cmd}`, {
        ...(flags.cancel ? { cancel: true } : {}), from, ...(fromToken ? { fromToken } : {}),
        ...(typeof flags.reason === "string" ? { reason: flags.reason } : {}), ...(flags.now ? { now: true } : {}),
        ...(typeof flags.in === "string" ? { in: flags.in } : {}), ...(typeof flags.at === "string" ? { at: flags.at } : {}),
      });
      if (r.ok === false) { console.error(String(r.error)); process.exit(1); }
      if (flags.json) { console.log(JSON.stringify(r)); return; }
      if (flags.cancel) { console.log(r.canceled ? `canceled; ${r.replayed} held message(s) released` : "nothing pending"); return; }
      const when = typeof r.fireAt === "number" && r.fireAt > Date.now() + 1000 ? `at ${new Date(r.fireAt).toLocaleString()}` : "now";
      console.log(`${r.kind} ${r.phase === "draining" ? "in progress" : "scheduled"} (${when}), requested by ${(r.requestedBy as string[]).join(", ")}. `
        + (flags.now ? "Running turns are not waited for." : "Running turns finish first; new messages wait and are replayed after it."));
      return;
    }
    case "start": {
      const rt = readRuntime(projectDir);
      if (rt && isAlive(rt.pid)) { console.log(`already running (pid ${rt.pid})`); return; }
      const logDir = join(stateDirOf(projectDir), "logs");
      mkdirSync(logDir, { recursive: true });
      const out = openSync(join(logDir, "stdout.log"), "a");
      const child = Bun.spawn([process.execPath, import.meta.path, "run", "--project", projectDir], {
        stdio: ["ignore", out, out], env: process.env,
      });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await Bun.sleep(200);
        const r = readRuntime(projectDir);
        if (r && r.pid === child.pid) { console.log(`started (pid ${r.pid}, api :${r.webPort ?? "-"}, mcp :${r.gatewayPort})`); return; }
        if (child.exitCode !== null) break;
      }
      console.error(`daemon did not come up — see ${join(logDir, "daemon.log")} and stdout.log`);
      process.exit(1);
    }
    case "stop": {
      const rt = readRuntime(projectDir);
      if (!rt || !isAlive(rt.pid)) { console.log("not running"); return; }
      process.kill(rt.pid, "SIGTERM");
      for (let i = 0; i < 50 && isAlive(rt.pid); i++) await Bun.sleep(200);
      console.log(isAlive(rt.pid) ? `pid ${rt.pid} did not exit` : "stopped");
      return;
    }
    case "status": {
      const rt = readRuntime(projectDir);
      if (!rt || !isAlive(rt.pid)) { console.log("not running"); return; }
      const s = await api(projectDir, "/api/status");
      const tp = Object.entries(rt.transportPorts ?? {}).map(([k, v]) => ` · ${k} :${v}`).join("");
      console.log(`UniQlaw ${s.version} · pid ${rt.pid} · instance ${rt.instanceId} · api :${rt.webPort} · mcp :${rt.gatewayPort}${tp}`);
      const rs = s.restart as { pending: boolean; phase?: string; kind?: string; fireAt?: number; requestedBy?: string[]; inflight?: string[]; deferred?: number } | undefined;
      if (rs?.pending) {
        console.log(rs.phase === "draining"
          ? `  ${rs.kind} draining: waiting for ${rs.inflight?.join(", ") || "nothing"} · ${rs.deferred ?? 0} message(s) held`
          : `  ${rs.kind} scheduled at ${new Date(rs.fireAt!).toLocaleString()} (requested by ${rs.requestedBy?.join(", ")})`);
      }
      for (const a of (s.agents as { name: string; profile: string; provider: string; state: string; queue: number; lastActivityAt: number }[])) {
        console.log(`  ${a.name.padEnd(28)} ${a.profile}/${a.provider}  ${a.state}${a.queue ? ` (+${a.queue} queued)` : ""}  ${a.lastActivityAt ? new Date(a.lastActivityAt).toLocaleString() : ""}`);
      }
      return;
    }
    case "ls": {
      const list = listInstances();
      if (!list.length) { console.log("no running instances"); return; }
      for (const r of list) console.log(`${r.instanceId}  pid ${r.pid}  api :${r.webPort ?? "-"}  ${r.projectDir}`);
      return;
    }
    case "send": {
      const [target, ...words] = pos;
      if (!target || !words.length) throw new Error("usage: uniqlaw send <target> <text>");
      console.log(JSON.stringify(await api(projectDir, "/api/send", { target, text: words.join(" "), fromLabel: "cli" })));
      return;
    }
    case "trigger": {
      const [target, ...words] = pos;
      if (!target || !words.length) throw new Error("usage: uniqlaw trigger <target> <prompt>");
      console.log(JSON.stringify(await api(projectDir, "/api/trigger", { target, prompt: words.join(" "), fromLabel: "cli" })));
      return;
    }
    case "pairing": {
      const [action, a, b] = pos;
      if (!action || action === "list") {
        const r = await api(projectDir, "/api/pairing");
        if (!r.ok) throw new Error(String(r.error));
        const pending = r.pending as { code: string; platform: string; userId: string; name: string; username?: string; expiresAt: number }[];
        const paired = r.paired as { platform: string; userId: string; name: string }[];
        console.log(pending.length ? "open requests:" : "no open requests");
        for (const p of pending) console.log(`  ${p.code.slice(0, 4)}-${p.code.slice(4)}  ${p.platform}  ${p.userId}  ${p.name}${p.username ? ` (@${p.username})` : ""}  expires ${new Date(p.expiresAt).toLocaleTimeString()}`);
        console.log(paired.length ? "paired users:" : "no paired users");
        for (const u of paired) console.log(`  ${u.platform}  ${u.userId}  ${u.name}`);
        return;
      }
      if ((action === "approve" || action === "deny") && a) {
        const r = await api(projectDir, "/api/pairing", { action, code: a });
        if (!r.ok) throw new Error(String(r.error));
        console.log(action === "approve" ? "approved" : "denied");
        return;
      }
      if (action === "revoke" && a && b) {
        const r = await api(projectDir, "/api/pairing", { action, platform: a, userId: b });
        console.log(r.ok ? "revoked" : "not a paired user");
        return;
      }
      throw new Error("usage: uniqlaw pairing [list] | pairing approve <code> | pairing deny <code> | pairing revoke <platform> <userId>");
    }
    case "workers": {
      const r = await api(projectDir, "/api/workers");
      if (!r.ok) throw new Error(String(r.error));
      const ws = r.workers as { name: string; profile: string; provider: string; state: string; cwd?: string; owner?: string; heldBy?: string }[];
      if (!ws.length) { console.log("no workers"); return; }
      for (const w of ws) console.log(`  ${w.name.padEnd(24)} ${w.profile}/${w.provider}  ${w.state}${w.heldBy ? ` (held by ${w.heldBy})` : ""}  ${w.cwd ?? ""}${w.owner ? `  ← ${w.owner}` : ""}`);
      return;
    }
    case "worker": {
      const [action, name, ...words] = pos;
      if ((action !== "start" && action !== "stop") || !name) throw new Error("usage: uniqlaw worker start <name> --profile P [--cwd DIR] [task...] | worker stop <name> [--forget]");
      const cwd = typeof flags.cwd === "string" ? resolve(flags.cwd) : undefined;
      const r = await api(projectDir, "/api/workers", { action, name, profile: flags.profile, cwd, task: words.join(" ") || undefined, forget: !!flags.forget, fromLabel: "cli" });
      if (!r.ok) throw new Error(String(r.error));
      console.log(JSON.stringify(r));
      return;
    }
    case "attach": {
      const [key] = pos;
      if (!key) throw new Error("usage: uniqlaw attach <worker|session>");
      const t = await api(projectDir, "/api/takeover", { key });
      if (!t.ok) throw new Error(String(t.error));
      const { argv, cwd, live, env } = t as unknown as { key: string; argv: string[]; cwd: string; live: boolean; env?: Record<string, string> };
      console.error(live
        ? `Attaching to ${t.key} (detach with Ctrl-b d; the agent keeps running and the daemon keeps watching).`
        : `${t.key} is handed to you in ${cwd}. Exit the agent to hand it back to UniQlaw.`);
      // Our own tmux client must not think it's nested inside the user's tmux.
      const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
      delete childEnv.TMUX;
      process.on("SIGINT", () => {}); // Ctrl-C belongs to the agent; we must survive to release
      try {
        const p = Bun.spawn(argv, { cwd, env: childEnv, stdio: ["inherit", "inherit", "inherit"] });
        await p.exited;
      } finally {
        const r = await api(projectDir, "/api/release", { key: t.key }).catch((e) => ({ ok: false, error: String(e) }));
        console.error(r.ok ? `Released ${t.key} back to UniQlaw.` : `warning: release failed (${String(r.error)}); run \`uniqlaw release ${t.key}\` when the daemon is reachable`);
      }
      return;
    }
    case "release": {
      const [key] = pos;
      if (!key) throw new Error("usage: uniqlaw release <worker|session>");
      const r = await api(projectDir, "/api/release", { key });
      if (!r.ok) throw new Error(String(r.error));
      console.log(r.released ? `Released ${key}.` : `${key} was not held from a terminal.`);
      return;
    }
    case "dream": {
      const r = await api(projectDir, "/api/dream", { dryRun: !!flags["dry-run"] });
      if (!r.ok) throw new Error(String(r.error));
      const rep = r.report as DreamReport;
      if (flags.json) { console.log(JSON.stringify(rep, null, 2)); return; }
      console.log(formatDreamReport(rep));
      return;
    }
    case "mcp-shim": {
      const { runMcpShim } = await import("./mcp-shim.ts");
      await runMcpShim();
      return;
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

if (import.meta.main) main().catch((e) => { console.error(`error: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });

function formatDreamReport(r: DreamReport): string {
  const out = [`${r.dryRun ? "Dry run" : "Sweep"} ${r.day}: ${r.considered} recent entries, ${r.candidates.length} candidate(s).`];
  for (const c of r.candidates) out.push(`  ✓ [${c.passed.join("+")}] score ${c.score} · recalled ${c.recallCount}× · ${c.day}  ${c.text.slice(0, 100)}`);
  if (r.rejected?.length) {
    out.push("Not promoted:");
    for (const c of r.rejected.slice(0, 20)) out.push(`  · ${c.text.slice(0, 80)}\n      ${c.excluded}`);
    if (r.rejected.length > 20) out.push(`  … ${r.rejected.length - 20} more (--json for all)`);
  }
  if (!r.dryRun) {
    const d = r.deep;
    out.push(`MEMORY.md: ${d.mode} — ${d.added} added, ${d.merged} merged, ${d.superseded} superseded, ${d.skipped} skipped${d.reason ? ` (${d.reason})` : ""}`);
    if (r.memoryBytes !== undefined) out.push(`  now ${r.memoryEntries} entries, ${r.memoryBytes} bytes`);
    if (r.diary) out.push("", r.diary);
  }
  return out.join("\n");
}
