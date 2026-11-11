// Daemon bootstrap: settings → instance lock → plugins → manager → gateway → HTTP API.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BRAND_PROMPT, ChannelManager, McpGateway, REACTION_PROMPT, SILENT_REPLY_PROMPT, StateStore, TranscriptStore, busToolsPrompt, internalSessionPrompt, expandHome, workerSessionPrompt, workersPrompt,
  createLogger, dirScopePrompt, memoryPrompt, runDreamSweep, DEFAULT_DREAMING, parseSettings, resolveSecret, MemoryStore, RestartCoordinator, type MemoryOriginKind, type RestartKind,
  type AgentProvider, type Credential, type Logger, type PlatformAdapter, type PluginContext, type PluginDef,
  type Profile, type Scheduler, type SecretRef, type Settings, type SessionContext, type SystemPromptParts, type Transcriber, type Transport,
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
  dreaming: () => import("@uniqlaw/scheduler/dreaming") as Promise<{ default: PluginDef }>,
  a2a: () => import("@uniqlaw/transport-a2a") as Promise<{ default: PluginDef }>,
  whisper: () => import("@uniqlaw/transcriber/whisper") as Promise<{ default: PluginDef }>,
  "transcribe-api": () => import("@uniqlaw/transcriber/api") as Promise<{ default: PluginDef }>,
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
  /** Graceful restart / reload requests (drain → persist → execute via onRestart). */
  restart: RestartCoordinator;
  webPort?: number;
  gatewayPort?: number;
}

export interface DaemonOptions {
  logToStderr?: boolean;
  /** Called once a graceful restart/reload has drained and written its record: stop this daemon and bring up the
   *  next one (runForever: reload = in-process, restart = new process). Resolve false if nothing was stopped.
   *  Without it restart requests are refused. */
  onRestart?: (kind: RestartKind) => void | boolean | Promise<void | boolean>;
  /** Called once the daemon is up and runtime.json is written, before it takes anything over from the previous
   *  process (reattaching sessions, the restart record, deferred input, open tasks). false = don't: this start is
   *  being abandoned (runForever: the restarting parent gave up on us) and is about to be stopped. */
  beforeResume?: () => Promise<boolean>;
}

export async function startDaemon(projectDirIn: string, opts: DaemonOptions = {}): Promise<Daemon> {
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
    const transcribers = new Map<string, Transcriber>();
    const neededProviders = new Set(Object.values(settings.profiles).map((p) => p.provider));
    const pluginNames = new Set([...Object.keys(settings.plugins), ...neededProviders, ...DEFAULT_ON]);
    for (const name of pluginNames) {
      const raw = (settings.plugins[name] ?? { enabled: true }) as Record<string, unknown> & { enabled: boolean };
      if (!raw.enabled) continue;
      const def = await loadPlugin(name, raw, projectDir);
      const { enabled: _e, module: _m, ...rest } = raw;
      const parsed = def.configSchema.safeParse(rest);
      if (!parsed.success) throw new Error(`plugins.${name}: ${parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}`);
      if (def.kind === "platform") {
        const secret = await claimSecret(rest);
        if (secret) cleanups.push(claim(`${name} bot token`, `${name}:${secret}`, projectDir));
      }
      const inst = await def.create(ctx(name), parsed.data);
      if (def.kind === "provider") providers.set(name, inst as AgentProvider);
      else if (def.kind === "scheduler") schedulers.set(name, inst as Scheduler);
      else if (def.kind === "transport") transports.set(name, inst as Transport);
      else if (def.kind === "transcriber") { transcribers.set(name, inst as Transcriber); cleanups.push(() => (inst as Transcriber).stop?.()); }
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
        permissions: p.permissions, options: { ...p.options, prompts: p.prompts }, ...(p.fallback.length ? { fallback: p.fallback } : {}) });
    }
    for (const [name, p] of Object.entries(settings.profiles)) {
      for (const f of p.fallback) if (!settings.profiles[f]) throw new Error(`profile "${name}": fallback "${f}" is not a profile`);
    }
    if (!profiles.has(settings.bindings.default)) throw new Error(`bindings.default "${settings.bindings.default}" is not a profile`);

    // ── memory ──
    const memory = settings.memory.enabled
      ? new MemoryStore(projectDir, store, { dir: settings.memory.dir, maxInjectBytes: settings.memory.maxInjectBytes, timezone: settings.timezone })
      : undefined;

    // ── gateway + manager ──
    let manager!: ChannelManager;
    const gateway = new McpGateway(() => manager, log.child("gateway"), join(stateDirOf(projectDir), "gateway.json"));
    if (memory) {
      const classify = (caller: string): MemoryOriginKind => {
        const k = manager.kindOf(caller);
        // Group chats include people who aren't operators: their notes are kept but never promoted.
        if (k === "chat") return store.getSession(caller)?.multiparty ? "group" : "chat";
        return k === "worker" ? "worker" : k === "a2a" ? "remote" : "internal";
      };
      gateway.addTools(memory.tools(classify, (caller) => caller !== DREAM_SESSION));
    }
    for (const s of schedulers.values()) if (s.tools) gateway.addTools(s.tools());
    const gatewayPort = gateway.start(settings.mcpGateway.host, settings.mcpGateway.port);
    cleanups.push(() => gateway.stop());

    const transcript = new TranscriptStore(store);
    const engine = settings.transcription.engine;
    const transcriber = engine === "none" ? undefined : transcribers.get(engine);
    if (engine !== "none" && !transcriber) throw new Error(`transcription.engine "${engine}" is not a loaded transcriber plugin; add "plugins": { "${engine}": { … } } (built-in: whisper, transcribe-api)`);
    manager = new ChannelManager({
      log, settings, store, transcript, projectDir, instanceId, providers, platforms, profiles, ...(transcriber ? { transcriber } : {}),
      gatewayFor: (key) => gateway.endpointFor(key),
      systemPrompt: (profile, multiparty, toolNames, session) => buildSystemPrompt(projectDir, settings, profile, multiparty, toolNames, session, memory),
      providerEnv: async () => {
        const env: Record<string, string> = {};
        for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k]!;
        env.UNIQLAW_INSTANCE = instanceId;
        return env;
      },
    });
    const restart = new RestartCoordinator({ manager, store, log: log.child("restart"), settings,
      validate: () => {
        if (!opts.onRestart) throw new Error("this daemon was started without a restart handler (run it with `uniqlaw run` / `uniqlaw start`)");
        loadSettings(projectDir);
      },
      execute: (kind) => opts.onRestart!(kind) });
    gateway.addTools(restart.tools());
    // Before restore(): reopening a session consumes its inflight-turn key, which re-arms the tasks it answers.
    restart.prepare();
    manager.start();
    cleanups.push(() => manager.stop());

    manager.pairing.sync(); // before start: paired users must be accepted from the first message
    for (const [name, p] of platforms) {
      await p.start({
        message: (m) => void manager.handleInbound(m).catch((e) => log.error("inbound failed", { platform: name, e: String(e) })),
        unknownSender: (u) => void manager.pairing.onUnknownSender(u).catch((e) => log.error("pairing failed", { platform: name, e: String(e) })),
      });
      cleanups.push(() => p.stop());
      if (p.setCommands) {
        await p.setCommands([
          { name: "stop", description: "Interrupt the agent and clear the queue" },
          { name: "new", description: "Start a fresh agent session" },
          { name: "status", description: "Show this channel's session status" },
          { name: "model", description: "Show or switch the model" },
          { name: "activation", description: "Group: answer only when mentioned, or every message (mention / always / reset)" },
          { name: "profile", description: "Show or switch this chat's profile (agent / model); reset = default" },
          { name: "pair", description: "Operator: list / approve / deny DM pairing requests" },
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
        complete: (o) => manager.complete(o),
        ...(memory ? { memory } : {}),
        noteToOpenChats: (label, text) => manager.noteToOpenChats(label, text),
        ...(restart.lastRestart() ? { lastRestart: restart.lastRestart()! } : {}),
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
      const api = startApi({ manager, store, host: settings.web.host, port: settings.web.port, log: log.child("api"), version: VERSION, token, restart,
        sessionForToken: (t) => gateway.sessionForToken(t),
        logFile: join(stateDir, "logs", "daemon.log"), jobsDir: resolve(projectDir, cronDir), timezone: settings.timezone,
        ...(memory ? { dream: async ({ dryRun }: { dryRun?: boolean }) => {
          const sch = schedulers.get("dreaming");
          if (sch?.runNow) return sch.runNow({ dryRun });
          // Not enabled: a dry run (ranking only, no model, no writes) still works with default thresholds.
          if (dryRun) return runDreamSweep({ memory, maxMemoryBytes: memory.maxInjectBytes, complete: async () => ({ ok: false, text: "dry run" }) }, DEFAULT_DREAMING, { dryRun: true });
          throw new Error("dreaming is not enabled: add \"dreaming\": {} under plugins in settings.json");
        } } : {}) });
      webPort = api.port;
      cleanups.push(() => api.stop());
    }

    cleanups.push(() => restart.stop());
    const transportPorts: Record<string, number> = {};
    for (const t of transports.values()) Object.assign(transportPorts, t.ports?.() ?? {});
    writeRuntime(projectDir, { pid: process.pid, instanceId, projectDir, startedAt: Date.now(), webPort, gatewayPort,
      ...(Object.keys(transportPorts).length ? { transportPorts } : {}), version: VERSION });
    log.info("ready", { webPort, gatewayPort, platforms: [...platforms.keys()], providers: [...providers.keys()], schedulers: [...schedulers.keys()] });

    // Take over from the previous process only now (runtime.json is written, the restarting parent has acked):
    // reattach sessions, replay deferred input, fail/re-arm open tasks, send the restart notices.
    if (await (opts.beforeResume?.() ?? Promise.resolve(true))) {
      await manager.restore();
      await restart.resume().catch((e) => log.error("restart resume failed", { e: String(e) }));
      restart.start();
    } else {
      log.warn("not taking over from the previous process: this start is being abandoned");
    }

    let stopped: Promise<void> | undefined;
    return {
      manager, restart, webPort, gatewayPort,
      // Idempotent and single-flight: a second call (SIGTERM during a restart) waits for the first.
      stop: () => (stopped ??= (async () => {
        log.info("stopping");
        for (const c of cleanups.reverse()) await Promise.resolve(c()).catch((e) => log.warn("cleanup failed", { e: String(e) }));
      })()),
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

/** Internal session the dreaming sweep runs its model turns in. */
export const DREAM_SESSION = "dream";

export async function buildSystemPrompt(projectDir: string, settings: Settings, profile: Profile, multiparty: boolean, toolNames: string[],
  session?: SessionContext, memory?: MemoryStore): Promise<SystemPromptParts> {
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
  // Memory: chats and internal sessions share one memory; workers work on code elsewhere and don't get it.
  if (memory && !session?.worker && session?.channelKey !== DREAM_SESSION && toolNames.includes("memory_search")) {
    fragments.push({ id: "memory", text: memoryPrompt(memory.injectText(), { canWrite: true, promotable: !session?.internal && !multiparty }) });
  }
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
// No top-level await here: run.ts imports this module, and awaiting it during this module's own
// evaluation is a circular-import deadlock (Bun >= 1.4 follows the spec and hangs).
if (import.meta.main) {
  void import("./run.ts").then(({ runForever }) => runForever(process.argv[2] ?? process.cwd(), { logToStderr: true }))
    .catch((e) => { console.error(e); process.exit(1); });
}
