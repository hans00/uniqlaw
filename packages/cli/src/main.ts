#!/usr/bin/env bun
// uniqlaw CLI: init | doctor | start | stop | reload | status | logs | ls | send | trigger | migrate | run | mcp-shim
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isAlive, listInstances, loadSettings, readRuntime, runForever, stateDirOf } from "@uniqlaw/daemon";
import { applyMigration, detectRunningV2, planMigration } from "@uniqlaw/migrate-v2";

const USAGE = `uniqlaw <command> [options]

  init     [--project DIR] [--yes …] [--force]   create .uniqlaw/settings.json (interactive wizard)
  doctor   [--project DIR]                     check tools, settings, credentials, ports, bot tokens
  logs     [--project DIR] [--lines N]         tail the daemon log
  run      [--project DIR]                     run the daemon in the foreground
  start    [--project DIR]                     start the daemon in the background
  stop     [--project DIR]                     stop the daemon
  reload   [--project DIR]                     re-read settings.json (rejected if invalid; old config keeps running)
  status   [--project DIR]                     show daemon + session status
  ls                                           list UniQlaw instances on this machine
  send     <target> <text...> [--project DIR]  post text to a chat (e.g. telegram:<chatId>)
  trigger  <target> <prompt...> [--project DIR] make a session answer its own chat
  migrate  --from <v2 dir> [--project DIR] [--dry-run] [--force]
  mcp-shim                                     stdio⇄HTTP MCP bridge to the gateway (env UNIQLAW_MCP_URL, UNIQLAW_TOKEN)
`;

const BOOL_FLAGS = new Set(["dry-run", "force", "json", "yes", "no-web", "heartbeat", "allow-empty", "telegram", "discord", "slack", "line"]);

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !BOOL_FLAGS.has(k)) { flags[k] = next; i++; }
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

async function api(projectDir: string, path: string, body?: unknown) {
  const rt = readRuntime(projectDir);
  if (!rt || !isAlive(rt.pid)) throw new Error(`daemon is not running for ${projectDir}`);
  if (!rt.webPort) throw new Error("daemon has the HTTP API disabled (web.enabled=false)");
  const res = await fetch(`http://127.0.0.1:${rt.webPort}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parse(rest);
  const projectDir = resolve(String(flags.project ?? process.cwd()));

  switch (cmd) {
    case "init": {
      if (flags.help || flags.h) {
        console.log(`uniqlaw init [--project DIR] [--force]                       interactive setup wizard
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
An empty platform allowlist is refused unless --allow-empty is given.`);
        return;
      }
      const init = await import("./init.ts");
      const available = init.detectProviders();
      if (init.hasV2(projectDir) && !flags.force) {
        console.log(`Found ClaudeClaw v2 config in ${projectDir}.
To carry it over instead: uniqlaw migrate --from ${projectDir} --project ${projectDir}  (see docs/MIGRATE.md)
`);
      }
      let answers;
      if (flags.yes) answers = init.answersFromFlags(flags, available);
      else {
        const r = new init.LineReader(process.stdin);
        if (init.hasV2(projectDir) && await r.yesNo("Migrate the ClaudeClaw v2 setup instead of starting fresh?", true)) {
          const plan = await planMigration(projectDir);
          console.log(JSON.stringify(await applyMigration(plan, projectDir, { dryRun: false, force: !!flags.force }), null, 2));
          process.exit(0);
        }
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
    case "reload": {
      // /api/reload is fire-and-forget (the daemon validates after replying), so validate here
      // first and report a broken settings.json instead of silently keeping the old config.
      try { loadSettings(projectDir); } catch (e) {
        console.error(`reload refused — settings.json is invalid, the running config is unchanged:\n${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      const r = await api(projectDir, "/api/reload", {});
      console.log(JSON.stringify(r));
      if (r.ok === false) process.exit(1);
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
    case "mcp-shim": {
      const { runMcpShim } = await import("./mcp-shim.ts");
      await runMcpShim();
      return;
    }
    case "migrate": {
      const from = flags.from ? resolve(String(flags.from)) : undefined;
      if (!from || !existsSync(from)) throw new Error("usage: uniqlaw migrate --from <v2 project dir> [--project DIR] [--dry-run] [--force]");
      const running = detectRunningV2(from);
      if (running.running && !flags["dry-run"]) throw new Error(`ClaudeClaw v2 is still running (pid ${running.pid}). Stop it first (/claudeclaw2:stop or kill -TERM ${running.pid}).`);
      const plan = await planMigration(from);
      const report = await applyMigration(plan, projectDir, { dryRun: !!flags["dry-run"], force: !!flags.force });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
  }
}

main().catch((e) => { console.error(`error: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
