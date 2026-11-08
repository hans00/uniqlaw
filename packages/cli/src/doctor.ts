// `uniqlaw doctor`: environment + configuration health check. Never prints secret values.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveSecret, type Credential, type SecretRef } from "@uniqlaw/core";
import { validateCredential } from "@uniqlaw/credentials";
import { claimsDir, isAlive, loadSettings, readRuntime } from "@uniqlaw/daemon";

/** ClaudeClaw v2 daemon liveness (its pid file), so doctor can flag two pollers on one bot. */
export function detectRunningV2(dir: string): { running: boolean; pid?: number } {
  const pidFile = join(resolve(dir), ".claude", "claudeclaw", "daemon.pid");
  if (!existsSync(pidFile)) return { running: false };
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { running: false };
  return isAlive(pid) ? { running: true, pid } : { running: false, pid };
}

export type Level = "ok" | "warn" | "fail";
export interface Check { level: Level; area: string; message: string }

const PROVIDER_BINARY: Record<string, string> = { "claude-tmux": "claude", "claude-sdk": "claude", codex: "codex", opencode: "opencode", agy: "agy" };
const SECRET_FIELDS = ["token", "botToken", "appToken", "channelAccessToken", "channelSecret"];
const PLATFORMS = new Set(["telegram", "discord", "slack", "line"]);

export interface DoctorDeps {
  which: (bin: string) => string | null;
  portFree: (host: string, port: number) => boolean;
}

const defaultDeps: DoctorDeps = {
  which: (b) => Bun.which(b),
  portFree: (host, port) => {
    try { const s = Bun.serve({ hostname: host, port, fetch: () => new Response("") }); s.stop(true); return true; }
    catch { return false; }
  },
};

export async function runDoctor(projectDirIn: string, deps: DoctorDeps = defaultDeps): Promise<Check[]> {
  const projectDir = resolve(projectDirIn);
  const out: Check[] = [];
  const add = (level: Level, area: string, message: string) => out.push({ level, area, message });

  add("ok", "runtime", `bun ${Bun.version}`);

  let settings: ReturnType<typeof loadSettings>;
  try { settings = loadSettings(projectDir); add("ok", "settings", `${join(projectDir, ".uniqlaw", "settings.json")} is valid`); }
  catch (e) { add("fail", "settings", e instanceof Error ? e.message : String(e)); return out; }

  const rt = readRuntime(projectDir);
  const running = !!rt && isAlive(rt.pid);
  add("ok", "daemon", running ? `running (pid ${rt!.pid}, api :${rt!.webPort ?? "-"}, mcp :${rt!.gatewayPort})` : "not running");

  // ── providers ──
  for (const [name, p] of Object.entries(settings.profiles)) {
    const bin = p.provider === "acp" ? String((p.options.command as string[] | undefined)?.[0] ?? "") : PROVIDER_BINARY[p.provider];
    if (bin) add(deps.which(bin) ? "ok" : "fail", "provider", `profile "${name}" (${p.provider}) needs \`${bin}\` on PATH${deps.which(bin) ? "" : " — not found"}`);
    if (p.provider === "claude-tmux") add(deps.which("tmux") ? "ok" : "fail", "provider", `claude-tmux needs tmux${deps.which("tmux") ? "" : " — not found"}`);
    if (p.provider === "agy") add("warn", "provider", "agy keeps its login in the system keyring: all instances on this machine share one Google account");
    if (p.credential && !settings.credentials[p.credential]) add("fail", "credentials", `profile "${name}" references unknown credential "${p.credential}"`);
  }
  if (!settings.profiles[settings.bindings.default]) add("fail", "settings", `bindings.default "${settings.bindings.default}" is not a profile`);

  // ── credentials ──
  for (const [name, c] of Object.entries(settings.credentials)) {
    const v = await validateCredential(c as Credential);
    if (v.ok) add(v.warnings.length ? "warn" : "ok", "credentials", `"${name}" (${c.kind}) ${v.warnings.length ? v.warnings.join("; ") : "resolves"}`);
    else add("fail", "credentials", `"${name}" (${c.kind}): ${v.errors.join("; ")}`);
  }

  // ── platforms ──
  const myTokens = new Map<string, string>(); // platform → resolved secret (kept in memory only, never printed)
  for (const [name, raw] of Object.entries(settings.plugins)) {
    if (!PLATFORMS.has(name) || !raw.enabled) continue;
    const cfg = raw as Record<string, unknown>;
    for (const k of SECRET_FIELDS) {
      const v = cfg[k];
      if (v === undefined) continue;
      if (typeof v === "string") {
        add("warn", "platforms", `${name}.${k} is stored inline in settings.json — prefer {"env": "…"} / {"file": "…"}`);
        if (["token", "botToken", "channelAccessToken"].includes(k)) myTokens.set(name, v);
        continue;
      }
      try {
        const s = await resolveSecret(v as SecretRef);
        if (!s) throw new Error("resolves to an empty value");
        add("ok", "platforms", `${name}.${k} resolves`);
        if (["token", "botToken", "channelAccessToken"].includes(k)) myTokens.set(name, s);
      } catch (e) { add("fail", "platforms", `${name}.${k}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const users = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : [];
    if (!users.length) add("warn", "platforms", `${name}.allowedUserIds is empty — the bot ignores everyone`);
  }

  // ── bot-token claims by other instances ──
  for (const [name, secret] of myTokens) {
    const file = join(claimsDir(), createHash("sha256").update(`${name}:${secret}`).digest("hex").slice(0, 32) + ".json");
    if (!existsSync(file)) continue;
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { pid: number; projectDir: string };
      if (isAlive(c.pid) && resolve(c.projectDir) !== projectDir) add("fail", "platforms", `${name} bot token is in use by the UniQlaw instance at ${c.projectDir} (pid ${c.pid})`);
    } catch {}
  }

  // ── ClaudeClaw v2 on the same bot ──
  const v2 = detectRunningV2(projectDir);
  if (existsSync(join(projectDir, ".claude", "claudeclaw", "settings.json"))) {
    let sameBot = false;
    try {
      const v2s = JSON.parse(readFileSync(join(projectDir, ".claude", "claudeclaw", "settings.json"), "utf8")) as Record<string, Record<string, unknown>>;
      for (const [name, secret] of myTokens) {
        const t = v2s[name]?.token ?? v2s[name]?.botToken ?? v2s[name]?.channelAccessToken;
        if (typeof t === "string" && t === secret) sameBot = true;
      }
    } catch {}
    if (v2.running && sameBot) add("fail", "v2", `ClaudeClaw v2 is running (pid ${v2.pid}) with the same bot token — stop it before starting UniQlaw`);
    else if (v2.running) add("warn", "v2", `ClaudeClaw v2 is running here (pid ${v2.pid})`);
    else add("ok", "v2", "ClaudeClaw v2 config present but not running");
  }

  // ── ports ──
  if (!running) {
    const ports: [string, string, number][] = [];
    if (settings.web.enabled && settings.web.port) ports.push(["web", settings.web.host, settings.web.port]);
    if (settings.mcpGateway.port) ports.push(["mcpGateway", settings.mcpGateway.host, settings.mcpGateway.port]);
    for (const [label, host, port] of ports) {
      const free = deps.portFree(host, port);
      add(free ? "ok" : "fail", "ports", `${label} ${host}:${port} ${free ? "is free" : `is in use${port === 4632 ? " (ClaudeClaw v2's default port)" : ""}`}`);
    }
  }
  return out;
}

export function formatChecks(checks: Check[]): string {
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  return checks.map((c) => `${icon[c.level]} [${c.area}] ${c.message}`).join("\n");
}
