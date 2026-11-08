// Daemon bootstrap: settings → instance lock → plugins → manager → gateway → HTTP API.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BRAND_PROMPT, ChannelManager, McpGateway, REACTION_PROMPT, SILENT_REPLY_PROMPT, StateStore, TranscriptStore, busToolsPrompt, internalSessionPrompt, expandHome, workerSessionPrompt, workersPrompt,
  createLogger, dirScopePrompt, parseSettings, resolveSecret,
  type AgentProvider, type Credential, type Logger, type PlatformAdapter, type PluginContext, type PluginDef,
  type Profile, type Scheduler, type SecretRef, type Settings, type SessionContext, type SystemPromptParts, type Transport,
} from "@uniqlaw/core";
import { acquireLock, claim, deriveInstanceId, registerInstance, stateDirOf, writeRuntime } from "./instance.ts";
import { startApi } from "./api.ts";

export * from "./instance.ts";

export const VERSION = "0.1.0";

/** Built-in plugins. External plugins: `plugins.<name>.module` = import specifier. */
const BUILTIN: Record<string, () => Promise<{ default: PluginDef }>> = {
  "claude-tmux": () => import("@uniqlaw/provider-claude-tmux") as Promise<{ default: PluginDef }>,
  "claude-sdk": () => import("@uniqlaw/provider-claude-sdk") as Promise<{ default: PluginDef }>,
  pi: () => import("@uniqlaw/provider-pi") as Promise<{ default: PluginDef }>,
  codex: () => import("@uniqlaw/provider-codex") as Promise<{ default: PluginDef }>,
  opencode: () => import("@uniqlaw/provider-opencode") as Promise<{ default: PluginDef }>,
  acp: () => import("@uniqlaw/provider-acp") as Promise<{ default: PluginDef }>,
  agy: () => import("@uniqlaw/provider-agy") as Promise<{ default: PluginDef }>,
  telegram: () => import("@uniqlaw/platform-telegram") as Promise<{ default: PluginDef }>,
  discord: () => import("@uniqlaw/platform-discord") as Promise<{ default: PluginDef }>,
  slack: () => import("@uniqlaw/platform-slack") as Promise<{ default: PluginDef }>,
  line: () => import("@uniqlaw/platform-line") as Promise<{ default: PluginDef }>,
  cron: () => import("@uniqlaw/scheduler/cron") as Promise<{ default: PluginDef }>,
  heartbeat: () => import("@uniqlaw/scheduler/heartbeat") as Promise<{ default: PluginDef }>,
  a2a: () => import("@uniqlaw/transport-a2a") as Promise<{ default: PluginDef }>,
};
/** Built-ins that load unless explicitly disabled. */
const DEFAULT_ON = ["cron"];

export function loadSettings(projectDir: string): Settings {
  const p = join(stateDirOf(projectDir), "settings.json");
  if (!existsSync(p)) throw new Error(`no settings at ${p} — run \`uniqlaw init\` (ClaudeClaw v2: follow docs/MIGRATE.md)`);
  return parseSettings(JSON.parse(readFileSync(p, "utf8")));
}

async function loadPlugin(name: string, cfg: Record<string, unknown>, projectDir: string): Promise<PluginDef> {
  const mod = typeof cfg.module === "string" ? await import(resolve(projectDir, cfg.module)) : await BUILTIN[name]?.();
  if (!mod?.default) throw new Error(`unknown plugin "${name}" (no built-in and no "module" given)`);
  return mod.default as PluginDef;
}

const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "XDG_RUNTIME_DIR", "TZ"];

export interface Daemon {
  stop(): Promise<void>;
  manager: ChannelManager;
  webPort?: number;
  gatewayPort?: number;
}

export async function startDaemon(projectDirIn: string, opts: { logToStderr?: boolean } = {}): Promise<Daemon> {
  const projectDir = resolve(projectDirIn);
  const stateDir = stateDirOf(projectDir);
  const settings = loadSettings(projectDir);
  const instanceId = deriveInstanceId(projectDir, settings.instance.id);
  const releaseLock = acquireLock(projectDir);
  const cleanups: (() => void | Promise<void>)[] = [releaseLock];
  const log: Logger = createLogger({ file: join(stateDir, "logs", "daemon.log"), stderr: opts.logToStderr });
  log.info("starting", { projectDir, instanceId, version: VERSION });

  try {
    registerInstance(instanceId, projectDir);
    const store = new StateStore(join(stateDir, "state.db"));
    cleanups.push(() => store.close());
    const ctx = (scope: string): PluginContext => ({ log: log.child(scope), instanceId, projectDir, stateDir, timezone: settings.timezone });

    // ── plugins ──
    const providers = new Map<string, AgentProvider>();
    const platforms = new Map<string, PlatformAdapter>();
    const schedulers = new Map<string, Scheduler>();
    const transports = new Map<string, Transport>();
    const neededProviders = new Set(Object.values(settings.profiles).map((p) => p.provider));
    const pluginNames = new Set([...Object.keys(settings.plugins), ...neededProviders, ...DEFAULT_ON]);
    for (const name of pluginNames) {
      const raw = (settings.plugins[name] ?? { enabled: true }) as Record<string, unknown> & { enabled: boolean };
      if (!raw.enabled) continue;
      const def = await loadPlugin(name, raw, projectDir);
      const { enabled: _e, module: _m, ...rest } = raw;
      const parsed = def.configSchema.safeParse(rest);
      if (!parsed.success) throw new Error(`plugins.${name}: ${parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      if (def.kind === "platform") {
        const secret = await claimSecret(rest);
        if (secret) cleanups.push(claim(`${name} bot token`, `${name}:${secret}`, projectDir));
      }
      const inst = await def.create(ctx(name), parsed.data);
      if (def.kind === "provider") providers.set(name, inst as AgentProvider);
      else if (def.kind === "scheduler") schedulers.set(name, inst as Scheduler);
      else if (def.kind === "transport") transports.set(name, inst as Transport);
      else platforms.set(name, inst as PlatformAdapter);
      log.info("plugin loaded", { name, kind: def.kind });
    }

    // ── profiles ──
    const profiles = new Map<string, Profile>();
    for (const [name, p] of Object.entries(settings.profiles)) {
      if (!providers.has(p.provider)) throw new Error(`profile "${name}": provider "${p.provider}" is not loaded`);
      let credentialResolved: Credential | undefined;
      if (p.credential) {
        credentialResolved = settings.credentials[p.credential] as Credential | undefined;
        if (!credentialResolved) throw new Error(`profile "${name}": unknown credential "${p.credential}"`);
      }
      profiles.set(name, { name, provider: p.provider, model: p.model, credential: p.credential, credentialResolved,
        permissions: p.permissions, options: { ...p.options, prompts: p.prompts } });
    }
    if (!profiles.has(settings.bindings.default)) throw new Error(`bindings.default "${settings.bindings.default}" is not a profile`);

    // ── gateway + manager ──
    let manager!: ChannelManager;
    const gateway = new McpGateway(() => manager, log.child("gateway"));
    for (const s of schedulers.values()) if (s.tools) gateway.addTools(s.tools());
    const gatewayPort = gateway.start(settings.mcpGateway.host, settings.mcpGateway.port);
    cleanups.push(() => gateway.stop());

    const transcript = new TranscriptStore(store);
    manager = new ChannelManager({
      log, settings, store, transcript, projectDir, instanceId, providers, platforms, profiles,
      gatewayFor: (key) => gateway.endpointFor(key),
      systemPrompt: (profile, multiparty, toolNames, session) => buildSystemPrompt(projectDir, settings, profile, multiparty, toolNames, session),
      providerEnv: async () => {
        const env: Record<string, string> = {};
        for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k]!;
        env.UNIQLAW_INSTANCE = instanceId;
        return env;
      },
    });
    await manager.restore();
    manager.start();
    cleanups.push(() => manager.stop());

    for (const [name, p] of platforms) {
      await p.start({ message: (m) => void manager.handleInbound(m).catch((e) => log.error("inbound failed", { platform: name, e: String(e) })) });
      cleanups.push(() => p.stop());
      if (p.setCommands) {
        await p.setCommands([
          { name: "stop", description: "Interrupt the agent and clear the queue" },
          { name: "new", description: "Start a fresh agent session" },
          { name: "status", description: "Show this channel's session status" },
          { name: "model", description: "Show or switch the model" },
        ]).catch((e) => log.warn("setCommands failed", { e: String(e) }));
      }
    }

    // ── schedulers (after platforms, so replyTo targets resolve) ──
    for (const [name, sch] of schedulers) {
      await sch.start({
        fire: (o) => manager.fireScheduled(o),
        isBusy: (k) => manager.isBusy(k),
        kvGet: (k) => store.get(`${name}:${k}`),
        kvSet: (k, v) => store.set(`${name}:${k}`, v),
      });
      cleanups.push(() => sch.stop());
    }

    // ── transports (A2A …): remote agents join agents_list; inbound requests run on profiles ──
    for (const [name, t] of transports) {
      await t.start({
        runInbound: (o) => manager.runInbound(o),
        profiles: () => [...profiles.values()].map((p) => ({ name: p.name, provider: p.provider })),
        maxHops: settings.bus.maxHops,
      });
      if (t.remoteAgents) manager.addRemoteAgents(t.remoteAgents());
      cleanups.push(() => t.stop());
      log.info("transport started", { name });
    }

    // ── HTTP API ──
    let webPort: number | undefined;
    if (settings.web.enabled) {
      const token = settings.web.token ? await resolveSecret(settings.web.token as SecretRef) : undefined;
      const cronDir = (settings.plugins.cron as { dir?: string } | undefined)?.dir ?? ".uniqlaw/jobs";
      const api = startApi({ manager, store, host: settings.web.host, port: settings.web.port, log: log.child("api"), version: VERSION, token,
        validateSettings: () => { loadSettings(projectDir); },
        logFile: join(stateDir, "logs", "daemon.log"), jobsDir: resolve(projectDir, cronDir), timezone: settings.timezone });
      webPort = api.port;
      cleanups.push(() => api.stop());
    }

    const transportPorts: Record<string, number> = {};
    for (const t of transports.values()) Object.assign(transportPorts, t.ports?.() ?? {});
    writeRuntime(projectDir, { pid: process.pid, instanceId, projectDir, startedAt: Date.now(), webPort, gatewayPort,
      ...(Object.keys(transportPorts).length ? { transportPorts } : {}), version: VERSION });
    log.info("ready", { webPort, gatewayPort, platforms: [...platforms.keys()], providers: [...providers.keys()], schedulers: [...schedulers.keys()] });

    return {
      manager, webPort, gatewayPort,
      stop: async () => {
        log.info("stopping");
        for (const c of cleanups.reverse()) await Promise.resolve(c()).catch((e) => log.warn("cleanup failed", { e: String(e) }));
      },
    };
  } catch (e) {
    log.error("startup failed", { e: e instanceof Error ? e.message : String(e) });
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
    throw e;
  }
}

async function claimSecret(cfg: Record<string, unknown>): Promise<string | undefined> {
  for (const k of ["token", "botToken", "channelAccessToken"]) {
    const v = cfg[k];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") { try { return await resolveSecret(v as SecretRef); } catch { return undefined; } }
  }
  return undefined;
}

export async function buildSystemPrompt(projectDir: string, settings: Settings, profile: Profile, multiparty: boolean, toolNames: string[],
  session?: SessionContext): Promise<SystemPromptParts> {
  const fragments: { id: string; text: string }[] = [{ id: "brand", text: BRAND_PROMPT }];
  // Workers get the profile's own prompt files only: the assistant persona (IDENTITY/USER/SOUL) is for chats.
  const files = (profile.options.prompts as string[] | undefined) ?? (session?.worker ? [] : settings.prompts.files);
  for (const f of files) {
    const p = resolve(projectDir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8").trim();
    if (text) fragments.push({ id: `file:${f}`, text });
  }
  if (profile.permissions.level !== "unrestricted") fragments.push({ id: "dir-scope", text: dirScopePrompt(session?.cwd ?? projectDir) });
  if (multiparty) fragments.push({ id: "silent", text: SILENT_REPLY_PROMPT });
  fragments.push({ id: "reactions", text: REACTION_PROMPT });
  if (toolNames.length) fragments.push({ id: "bus-tools", text: busToolsPrompt(toolNames) });
  if (session?.internal) fragments.push({ id: "internal-session", text: internalSessionPrompt(session.channelKey) });
  if (toolNames.includes("worker_start")) {
    const roots = settings.workers.roots.length ? settings.workers.roots.map((r) => resolve(projectDir, expandHome(r))) : [projectDir];
    const allowed = Object.entries(settings.profiles).filter(([n]) => !settings.workers.profiles.length || settings.workers.profiles.includes(n))
      .map(([name, p]) => ({ name, provider: p.provider, ...(p.model ? { model: p.model } : {}) }));
    fragments.push({ id: "workers", text: workersPrompt(roots, allowed) });
  }
  if (session?.worker) fragments.push({ id: "worker-session", text: workerSessionPrompt(session.channelKey, session.cwd ?? projectDir, session.worker.owner) });
  return { fragments };
}

export { runForever } from "./run.ts";

/** Foreground entry: `bun packages/daemon/src/index.ts <projectDir>`. */
if (import.meta.main) {
  const { runForever } = await import("./run.ts");
  await runForever(process.argv[2] ?? process.cwd(), { logToStderr: true });
}
