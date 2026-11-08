// Owns all ChannelRuntimes: inbound routing, core slash commands, the message
// bus (agents_list / agent_ask / agent_trigger / notify) and idle cleanup.
import type { AgentProvider, Profile } from "./provider.ts";
import type { RemoteAgent, ScheduledFire } from "./plugin.ts";
import type { InboundMessage, PlatformAdapter, Target } from "./platform.ts";
import type { Origin } from "./origin.ts";
import { ChannelRuntime, type RuntimeHost } from "./runtime.ts";
import { renderSourceLine } from "./format.ts";
import { EventEmitter } from "node:events";
import type { RuntimeEvent, TranscriptStore } from "./transcript.ts";
import { realpathSync, statSync } from "node:fs";
import { expandHome } from "./credentials.ts";
import { isAbsolute, resolve, sep } from "node:path";

export interface ManagerDeps extends Omit<RuntimeHost, "onTaskResult" | "platform" | "operatorTargets" | "emit" | "isInternal" | "cwdFor" | "workerOf" | "backgroundTarget"> {
  providers: Map<string, AgentProvider>;
  platforms: Map<string, PlatformAdapter>;
  profiles: Map<string, Profile>;
}

export interface AgentInfo {
  name: string;
  /** chat: bound to a chat (name is also its notify/trigger target); internal: no chat (heartbeat,
   *  cron jobs, "global"); a2a: serving a remote A2A caller; remote: a remote A2A agent. */
  kind: "chat" | "internal" | "a2a" | "remote" | "worker";
  profile: string;
  provider: string;
  state: string;
  multiparty: boolean;
  lastActivityAt: number;
  queue: number;
  /** Workers: working directory, the session that started it, and who holds it (a human attached). */
  cwd?: string;
  owner?: string;
  heldBy?: string;
}

/** A worker: a session running some coding agent (profile) in some directory, started by another session. */
export interface WorkerMeta { cwd: string; profile: string; owner?: string; createdAt: number }

export const WORKER_PREFIX = "worker:";
const WORKER_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** How a human takes over a session in a terminal (provider-specific). */
export interface TakeoverInfo { key: string; argv: string[]; cwd: string; live: boolean;
  /** Non-secret env the command needs (e.g. CLAUDE_CONFIG_DIR for an alternate login). */
  env?: Record<string, string> }

type TaskWaiter = { resolve: (r: { ok: boolean; text: string }) => void };

export class ChannelManager {
  readonly runtimes = new Map<string, ChannelRuntime>();
  /** Live runtime events ("event" → RuntimeEvent) for dashboards. */
  readonly events = new EventEmitter();
  private remotes = new Map<string, RemoteAgent>();
  /** channelKey → profile override (A2A sessions run on the profile they were addressed to). */
  private profileOverride = new Map<string, string>();
  private waiters = new Map<string, TaskWaiter>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly host: RuntimeHost;

  constructor(private readonly deps: ManagerDeps) {
    this.host = {
      ...deps,
      platform: (n) => deps.platforms.get(n),
      operatorTargets: () => [...deps.platforms.values()].flatMap((p) => p.operatorTargets()),
      onTaskResult: (id, ok, text) => this.completeTask(id, ok, text),
      emit: (ev: RuntimeEvent) => { this.events.emit("event", ev); },
      isInternal: (k) => this.kindOf(k) === "internal",
      cwdFor: (k) => deps.store.get(`session-cwd:${k}`),
      workerOf: (k) => { const m = this.workerMeta(k); return m ? { owner: m.owner } : undefined; },
      backgroundTarget: (k) => {
        if (!k.startsWith(WORKER_PREFIX)) return undefined;
        // Workers have no chat: background output (e.g. a human typing in its terminal) goes to the
        // chat attached to it, else nowhere (it stays in the transcript).
        const chat = this.attachedChat(k);
        return (chat ? this.targetForChannel(chat) : undefined) ?? null;
      },
    };
    this.events.setMaxListeners(100);
  }

  start() {
    const { checkIntervalMinutes, idleTimeoutHours } = this.deps.settings.sessionCleanup;
    if (idleTimeoutHours > 0) {
      this.cleanupTimer = setInterval(() => void this.cleanupIdle(idleTimeoutHours * 3600_000), checkIntervalMinutes * 60_000);
    }
  }

  async stop() {
    clearInterval(this.cleanupTimer);
    // Keep provider processes alive where the adapter supports reattach (claude-tmux keeps tmux).
    await Promise.all([...this.runtimes.values()].map((r) => r.detach()));
  }

  addRemoteAgents(list: RemoteAgent[]) { for (const r of list) this.remotes.set(r.name, r); }

  /** Sessions pinned to a profile by a scheduled job/heartbeat (`profile:` option), persisted across restarts. */
  private pinnedProfile(channelKey: string): string | undefined { return this.deps.store.get(`session-profile:${channelKey}`); }

  kindOf(channelKey: string): AgentInfo["kind"] {
    if (channelKey.startsWith("a2a:")) return "a2a";
    if (channelKey.startsWith(WORKER_PREFIX)) return "worker";
    return this.targetForChannel(channelKey) ? "chat" : "internal";
  }

  profileFor(channelKey: string): Profile {
    const name = this.profileOverride.get(channelKey) ?? this.pinnedProfile(channelKey)
      ?? this.deps.settings.bindings.channels[channelKey] ?? this.deps.settings.bindings.default;
    const p = this.deps.profiles.get(name);
    if (!p) throw new Error(`channel ${channelKey} is bound to unknown profile "${name}"`);
    return p;
  }

  runtime(channelKey: string, multiparty = false): ChannelRuntime {
    let rt = this.runtimes.get(channelKey);
    if (rt) return rt;
    const profile = this.profileFor(channelKey);
    const provider = this.deps.providers.get(profile.provider);
    if (!provider) throw new Error(`profile ${profile.name} uses unknown provider "${profile.provider}"`);
    const row = this.deps.store.getSession(channelKey);
    rt = new ChannelRuntime(channelKey, profile, provider, this.host, row?.multiparty ?? multiparty);
    this.runtimes.set(channelKey, rt);
    return rt;
  }

  /** Reattach sessions persisted from a previous run whose provider can resume them. */
  async restore() {
    for (const row of this.deps.store.listSessions()) {
      if (!row.providerSessionId || this.runtimes.has(row.channelKey)) continue;
      // A handoff takeover is still in progress: the human's own CLI owns the conversation.
      if (this.terminalHold(row.channelKey)?.live === false) continue;
      try { this.runtime(row.channelKey, row.multiparty); } catch (e) { this.deps.log.warn("restore skipped", { key: row.channelKey, e: String(e) }); }
    }
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  async handleInbound(msg: InboundMessage): Promise<void> {
    const platform = this.deps.platforms.get(msg.platform);
    const reply = (t: string) => platform?.send({ ...msg.replyTarget, replyToMessageId: msg.ref.messageId }, t);
    const att = msg.text.trim().match(/^\/(attach|detach)(?:@\S+)?(?:\s+(\S+))?\s*$/i);
    if (att && msg.trusted) { await reply(this.chatAttachCommand(msg.channelKey, att[1]!.toLowerCase(), att[2])); return; }
    // A chat attached to a worker talks to the worker instead of its own session.
    const attached = this.deps.store.get(`chat-attach:${msg.channelKey}`);
    const sessionKey = attached && this.workerMeta(attached) ? attached : msg.channelKey;
    const rt = this.runtime(sessionKey, sessionKey === msg.channelKey ? msg.multiparty : false);
    if (msg.trusted && rt.tryConsumeAwaitedInput(msg.text)) { await reply("✅ Sent to the agent."); return; }

    const cmd = msg.text.trim().match(/^\/(stop|new|status|model)(?:@\S+)?(?:\s+(.+))?$/i);
    if (cmd && msg.trusted) {
      const [, name, arg] = cmd;
      switch (name!.toLowerCase()) {
        case "stop": await reply((await rt.stop()) ? "⏹ Stopped." : "Nothing running."); return;
        case "new": await rt.reset(); await reply("🆕 Started a new session."); return;
        case "status": await reply(this.statusText(sessionKey)); return;
        case "model":
          if (!arg) { await reply(`Model: ${rt.profile.model ?? "(provider default)"}`); return; }
          await reply((await rt.setModel(arg.trim())) ? `Model → ${arg.trim()}` : "This provider can't switch models live.");
          return;
      }
    }
    const origin: Origin = { kind: "human", platform: msg.platform, channelKey: msg.channelKey, sender: msg.sender,
      replyTarget: msg.replyTarget, ref: msg.ref, trusted: msg.trusted };
    await rt.enqueue({
      origin,
      item: { text: msg.text, receivedAt: msg.receivedAt, sourceLine: renderSourceLine(msg.platform, msg.sender) },
      attachments: msg.attachments,
    });
  }

  statusText(channelKey: string): string {
    const rt = this.runtimes.get(channelKey);
    const row = this.deps.store.getSession(channelKey);
    return [
      `**${channelKey}**`,
      `profile: ${rt?.profile.name ?? row?.profile ?? "-"} (${rt?.profile.provider ?? row?.provider ?? "-"})`,
      `state: ${rt?.state ?? "closed"} · queue: ${rt?.queueLength ?? 0}`,
      `session: ${row?.providerSessionId ?? "(new)"}`,
      ...(this.workerMeta(channelKey) ? [`cwd: ${this.workerMeta(channelKey)!.cwd}`, `owner: ${this.workerMeta(channelKey)!.owner ?? "-"}`,
        `held by: ${this.heldBy(channelKey) ?? "-"}`] : []),
    ].join("\n");
  }

  // ── bus ──────────────────────────────────────────────────────────────────

  listAgents(): AgentInfo[] {
    const keys = new Set([...this.deps.store.listSessions().map((s) => s.channelKey), ...this.runtimes.keys(),
      ...this.listWorkers().map((w) => w.key)]);
    return [...keys].map((k): AgentInfo => {
      const rt = this.runtimes.get(k);
      const row = this.deps.store.getSession(k);
      const w = this.workerMeta(k);
      const held = w ? this.heldBy(k) : undefined;
      return { name: k, kind: this.kindOf(k), profile: rt?.profile.name ?? row?.profile ?? w?.profile ?? "?",
        provider: rt?.profile.provider ?? row?.provider ?? (w ? this.deps.profiles.get(w.profile)?.provider : undefined) ?? "?",
        state: rt?.state ?? "closed", multiparty: rt?.multiparty ?? row?.multiparty ?? false,
        lastActivityAt: row?.lastActivityAt ?? 0, queue: rt?.queueLength ?? 0,
        ...(w ? { cwd: w.cwd, ...(w.owner ? { owner: w.owner } : {}), ...(held ? { heldBy: held } : {}) } : {}) };
    }).concat([...this.remotes.values()].map((r): AgentInfo => ({ name: r.name, kind: "remote", profile: r.description ?? "remote", provider: r.name.split(":")[0] ?? "remote",
      state: "remote", multiparty: false, lastActivityAt: 0, queue: 0 })));
  }

  private checkHop(from: string): number {
    const hop = (this.runtimes.get(from)?.currentHop() ?? 0) + 1;
    if (hop > this.deps.settings.bus.maxHops) throw new Error(`delegation chain too deep (hop ${hop} > ${this.deps.settings.bus.maxHops}); answer directly instead`);
    return hop;
  }

  private resolveAgent(to: string): string {
    // Existing sessions: chats, internal sessions (heartbeat, cron:<job>, …), A2A contexts, workers.
    if (this.runtimes.has(to) || this.deps.store.getSession(to) || this.workerMeta(to)) return to;
    if (this.workerMeta(WORKER_PREFIX + to)) return WORKER_PREFIX + to;
    // Accept v2 peer names (claudeclaw-discord-123) and "uniqlaw-<key>" forms.
    const m = to.match(/^(?:claudeclaw|uniqlaw)-(.+)$/);
    if (m) {
      const k = m[1]!.replace(/^(telegram|discord|slack|line)-/, "$1:");
      if (this.runtimes.has(k) || this.deps.store.getSession(k)) return k;
    }
    // A channel key a platform can address may start a session on demand (v2 trigger semantics).
    if (this.targetForChannel(to)) return to;
    throw new Error(`unknown agent "${to}" — call agents_list`);
  }

  /** agent_ask: peer answers the caller. Returns the answer (wait) or the task id. */
  async ask(from: string, to: string, message: string, wait: boolean): Promise<{ taskId: string; result?: { ok: boolean; text: string } }> {
    const remote = this.remotes.get(to);
    if (remote) return this.askRemote(from, remote, message, wait);
    const target = this.resolveAgent(to);
    if (target === from) throw new Error("cannot ask yourself");
    this.checkNotHeld(target);
    const hop = this.checkHop(from);
    const taskId = crypto.randomUUID();
    this.deps.store.createTask({ taskId, fromSession: from, toSession: target, mode: "ask", request: message });
    const done = wait ? this.waitTask(taskId) : undefined;
    if (!wait) this.waiters.set(taskId, { resolve: (r) => this.deliverAsyncResult(from, target, taskId, hop, r) });
    await this.runtime(target).enqueue({
      origin: { kind: "peer", fromSession: from, hop, mode: "ask", taskId, rootTarget: this.runtimes.get(from)?.rootTarget() },
      item: { text: message, receivedAt: Date.now(), sourceLine: `[Agent message from session ${from} — reply here; your reply is returned to that agent, no human sees it]`, raw: true },
      attachments: [],
    });
    this.deps.store.updateTask(taskId, "working");
    if (!done) return { taskId };
    const timeout = this.deps.settings.bus.askTimeoutSec * 1000;
    const result = await Promise.race([done, new Promise<{ ok: boolean; text: string }>((r) => setTimeout(() => r({ ok: false, text: `timed out after ${timeout / 1000}s; the task keeps running — check task_status(${taskId})` }), timeout))]);
    return { taskId, result };
  }

  private async askRemote(from: string, remote: RemoteAgent, message: string, wait: boolean) {
    const hop = this.checkHop(from);
    const taskId = crypto.randomUUID();
    this.deps.store.createTask({ taskId, fromSession: from, toSession: remote.name, mode: "ask", request: message });
    this.deps.store.updateTask(taskId, "working");
    const run = remote.ask({ from, message, hop }).catch((e) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }))
      .then((r) => { this.deps.store.updateTask(taskId, r.ok ? "completed" : "failed", r.text); return r; });
    if (wait) return { taskId, result: await run };
    void run.then((r) => this.deliverAsyncResult(from, remote.name, taskId, hop, r));
    return { taskId };
  }

  /** Inbound request from a remote agent (A2A) against a local profile. */
  async runInbound(o: { profile: string; remote: string; contextId: string; taskId: string; text: string; hop: number }): Promise<{ ok: boolean; text: string }> {
    if (!this.deps.profiles.has(o.profile)) return { ok: false, text: `unknown profile "${o.profile}"` };
    if (o.hop > this.deps.settings.bus.maxHops) return { ok: false, text: "delegation chain too deep" };
    const key = `a2a:${o.profile}:${o.contextId}`;
    this.profileOverride.set(key, o.profile);
    this.deps.store.createTask({ taskId: o.taskId, fromSession: `a2a:${o.remote}`, toSession: key, mode: "ask", request: o.text });
    const done = this.waitTask(o.taskId);
    await this.runtime(key).enqueue({
      origin: { kind: "a2a", remote: o.remote, taskId: o.taskId, hop: o.hop },
      item: { text: o.text, receivedAt: Date.now(), sourceLine: `[A2A request from remote agent ${o.remote} — your reply is returned to it; no human sees it]`, raw: true },
      attachments: [],
    });
    this.deps.store.updateTask(o.taskId, "working");
    return done;
  }

  /** agent_trigger: peer answers its own human. */
  async trigger(from: string, to: string, prompt: string, replyTo?: Target): Promise<{ taskId: string }> {
    if (this.remotes.has(to)) throw new Error(`"${to}" is a remote agent; use agent_ask (remote agents have no chat here to answer on)`);
    const target = this.resolveAgent(to);
    this.checkNotHeld(target);
    const hop = this.checkHop(from);
    const rt = this.runtime(target);
    const deliverTo = replyTo ?? rt.lastTarget() ?? this.targetForChannel(target);
    if (!deliverTo) throw new Error(`"${target}" has no chat to answer on; pass replyTo`);
    const taskId = crypto.randomUUID();
    this.deps.store.createTask({ taskId, fromSession: from, toSession: target, mode: "trigger", request: prompt });
    this.waiters.set(taskId, { resolve: (r) => {
      // Only sessions get the echo; CLI/API callers ("cli", "api", …) are not sessions.
      if (this.deps.store.getSession(from)) this.deps.store.pushPending(from, "peer-result", { label: `trigger response from ${target}`, text: r.text });
    } });
    await rt.enqueue({
      origin: { kind: "peer", fromSession: from, hop, mode: "trigger", taskId, deliverTo },
      item: { text: prompt, receivedAt: Date.now(), sourceLine: `[Triggered by session ${from} — your reply goes to this channel's chat]`, raw: true },
      attachments: [],
    });
    return { taskId };
  }

  /** notify: post text to a chat target and echo it into the owning session's pending input. */
  async notify(from: string, targetStr: string, text: string): Promise<{ target: string; owner: string }> {
    const [platformName] = targetStr.split(":");
    const platform = platformName ? this.deps.platforms.get(platformName) : undefined;
    const target = platform?.parseTarget(targetStr);
    if (!platform || !target) throw new Error(`cannot resolve target "${targetStr}" (expected e.g. telegram:<chatId>)`);
    await platform.send(target, text);
    const owner = platform.channelKeyForTarget(target);
    if (owner !== from) this.deps.store.pushPending(owner, "notify-echo", { label: `sent on your behalf by ${from}`, text });
    return { target: targetStr, owner };
  }

  taskStatus(taskId: string) { return this.deps.store.getTask(taskId); }

  get transcript(): TranscriptStore | undefined { return this.deps.transcript; }

  /** Scheduled turn (cron / heartbeat). deliverTo is a target string like "telegram:<chatId>", or "none". */
  async fireScheduled(o: ScheduledFire) {
    if (this.workerMeta(o.channelKey) && this.heldBy(o.channelKey)) {
      this.deps.log.warn("scheduled job skipped: a human is driving this worker", { job: o.job, key: o.channelKey, by: this.heldBy(o.channelKey) });
      return;
    }
    const silent = o.deliverTo?.trim().toLowerCase() === "none";
    const deliverTo = o.deliverTo && !silent ? this.parseTargetString(o.deliverTo) : undefined;
    if (o.deliverTo && !silent && !deliverTo) this.deps.log.warn("scheduled job has an unresolvable replyTo; output follows backgroundNotify", { job: o.job, replyTo: o.deliverTo });
    if (o.profile) await this.pinProfile(o.channelKey, o.profile, o.job);
    await this.runtime(o.channelKey).enqueue({
      origin: { kind: "scheduler", job: o.job, deliverTo, ...(silent ? { silent } : {}), ...(o.model ? { model: o.model } : {}) },
      item: { text: o.text, receivedAt: Date.now(), sourceLine: o.sourceLine, raw: o.raw },
      attachments: [],
    });
  }

  /** Pin a session to a profile (sticky in state.db). An idle runtime on another profile is
   *  reopened; a busy one keeps its profile until it is next idle-closed or restarted. */
  private async pinProfile(channelKey: string, profile: string, job: string) {
    if (!this.deps.profiles.has(profile)) { this.deps.log.warn("scheduled job names an unknown profile; ignored", { job, profile }); return; }
    if (this.pinnedProfile(channelKey) !== profile) this.deps.store.set(`session-profile:${channelKey}`, profile);
    const rt = this.runtimes.get(channelKey);
    if (!rt || rt.profile.name === profile) return;
    if (rt.state === "running" || rt.state === "interrupting" || rt.queueLength > 0) {
      this.deps.log.warn("session is busy; profile change applies after it closes", { key: channelKey, profile });
      return;
    }
    await rt.close();
    this.runtimes.delete(channelKey);
  }

  // ── workers ──────────────────────────────────────────────────────────────

  workerMeta(key: string): WorkerMeta | undefined {
    if (!key.startsWith(WORKER_PREFIX)) return undefined;
    const v = this.deps.store.get(`worker-meta:${key}`);
    return v ? (JSON.parse(v) as WorkerMeta) : undefined;
  }

  listWorkers(): (WorkerMeta & { key: string })[] {
    return this.deps.store.entries("worker-meta:").map(([k, v]) => ({ key: k.slice("worker-meta:".length), ...(JSON.parse(v) as WorkerMeta) }));
  }

  private workerKey(name: string): string {
    const n = name.startsWith(WORKER_PREFIX) ? name.slice(WORKER_PREFIX.length) : name;
    if (!WORKER_NAME.test(n)) throw new Error(`invalid worker name "${name}" (lowercase letters, digits, . _ -; max 48)`);
    return WORKER_PREFIX + n;
  }

  /** Directories workers may use: settings.workers.roots (realpath), default the project dir. */
  private workerRoots(): string[] {
    const roots = this.deps.settings.workers.roots.length ? this.deps.settings.workers.roots : [this.deps.projectDir];
    return roots.flatMap((r) => {
      try { return [realpathSync(absPath(r, this.deps.projectDir))]; } catch { return []; }
    });
  }

  private resolveWorkerCwd(cwd: string): string {
    let real: string;
    try { real = realpathSync(absPath(cwd, this.deps.projectDir)); } catch { throw new Error(`directory not found: ${cwd}`); }
    if (!statSync(real).isDirectory()) throw new Error(`not a directory: ${cwd}`);
    const roots = this.workerRoots();
    if (!roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) {
      throw new Error(`${real} is outside the allowed worker directories (${roots.join(", ") || "none"}); the operator can add it to settings workers.roots`);
    }
    return real;
  }

  /** worker_start: create (or reuse) a worker and optionally hand it a task (agent_ask semantics). */
  async startWorker(from: string, o: { name: string; profile?: string; cwd?: string; task?: string; wait?: boolean }):
    Promise<{ worker: string; cwd: string; profile: string; created: boolean; taskId?: string; result?: { ok: boolean; text: string } }> {
    const key = this.workerKey(o.name);
    let meta = this.workerMeta(key);
    let created = false;
    if (meta) {
      if (o.profile && o.profile !== meta.profile) throw new Error(`${key} already exists with profile "${meta.profile}"; stop it with forget=true or pick another name`);
      if (o.cwd && this.resolveWorkerCwd(o.cwd) !== meta.cwd) throw new Error(`${key} already exists in ${meta.cwd}; a worker's directory is fixed — pick another name`);
    } else {
      const cfg = this.deps.settings.workers;
      if (this.listWorkers().length >= cfg.max) throw new Error(`worker limit reached (${cfg.max}); stop one with worker_stop forget=true`);
      if (!o.profile) throw new Error("profile is required for a new worker");
      if (!this.deps.profiles.has(o.profile)) throw new Error(`unknown profile "${o.profile}" (have: ${[...this.deps.profiles.keys()].join(", ")})`);
      if (cfg.profiles.length && !cfg.profiles.includes(o.profile)) throw new Error(`profile "${o.profile}" is not allowed for workers (allowed: ${cfg.profiles.join(", ")})`);
      const cwd = this.resolveWorkerCwd(o.cwd ?? this.deps.projectDir);
      meta = { cwd, profile: o.profile, owner: from, createdAt: Date.now() };
      this.deps.store.set(`worker-meta:${key}`, JSON.stringify(meta));
      this.deps.store.set(`session-cwd:${key}`, cwd);
      this.deps.store.set(`session-profile:${key}`, o.profile);
      created = true;
      this.deps.log.info("worker created", { key, cwd, profile: o.profile, owner: from });
    }
    const base = { worker: key, cwd: meta.cwd, profile: meta.profile, created };
    if (!o.task) {
      // Start the agent so a human can attach right away (not while a human holds it).
      if (!this.heldBy(key)) await this.runtime(key).ensureOpen();
      return base;
    }
    const r = await this.ask(from, key, o.task, o.wait ?? false);
    return { ...base, ...r };
  }

  /** worker_stop: close the worker's agent. forget=true also deletes its conversation and record (files are untouched). */
  async stopWorker(name: string, forget = false): Promise<{ worker: string; forgotten: boolean }> {
    const key = this.workerKey(name);
    if (!this.workerMeta(key)) throw new Error(`unknown worker "${name}"`);
    const by = this.heldBy(key);
    if (by) throw new Error(`${key} is held by ${by}; wait until the human detaches`);
    const rt = this.runtimes.get(key);
    if (rt) { await rt.close(); this.runtimes.delete(key); }
    if (forget) {
      for (const k of ["worker-meta", "session-cwd", "session-profile", "hold"]) this.deps.store.del(`${k}:${key}`);
      for (const [k, v] of this.deps.store.entries("chat-attach:")) if (v === key) this.deps.store.del(k);
      this.deps.store.deleteSession(key);
    }
    return { worker: key, forgotten: forget };
  }

  private attachedChat(workerKey: string): string | undefined {
    for (const [k, v] of this.deps.store.entries("chat-attach:")) if (v === workerKey) return k.slice("chat-attach:".length);
    return undefined;
  }

  /** Who is driving the worker right now, if a human is (chat key or "terminal"). */
  heldBy(key: string): string | undefined {
    return this.terminalHold(key)?.by ?? this.attachedChat(key);
  }

  /** Terminal takeover in progress (kv, so a daemon restart doesn't reopen a handed-off session). */
  private terminalHold(key: string): { by: string; live: boolean } | undefined {
    const v = this.deps.store.get(`hold:${key}`);
    return v ? (JSON.parse(v) as { by: string; live: boolean }) : undefined;
  }

  private checkNotHeld(key: string) {
    const by = this.workerMeta(key) ? this.heldBy(key) : undefined;
    if (by) throw new Error(`${key} is being driven by a human (${by}); try again after they detach`);
  }

  private chatAttachCommand(chatKey: string, cmd: string, arg?: string): string {
    const cur = this.deps.store.get(`chat-attach:${chatKey}`);
    if (cmd === "detach") {
      if (!cur) return "This chat is not attached to a worker.";
      this.deps.store.del(`chat-attach:${chatKey}`);
      this.noteHumanDone(cur);
      return `Detached from ${cur}. Messages here go to this chat's own session again.`;
    }
    if (!arg) {
      const ws = this.listWorkers();
      const lines = ws.map((w) => `• ${w.key} — ${w.profile} in ${w.cwd}${this.heldBy(w.key) ? ` (held by ${this.heldBy(w.key)})` : ""}`);
      return [cur ? `Attached to ${cur}. /detach to return.` : "Not attached.", ws.length ? "Workers:" : "No workers.", ...lines, "Usage: /attach <worker>"].join("\n");
    }
    const key = this.workerKey(arg);
    if (!this.workerMeta(key)) return `Unknown worker "${arg}". /attach lists them.`;
    const by = this.heldBy(key);
    if (by && by !== chatKey) return `${key} is already held by ${by}.`;
    if (cur && cur !== key) { this.deps.store.del(`chat-attach:${chatKey}`); this.noteHumanDone(cur); }
    this.deps.store.set(`chat-attach:${chatKey}`, key);
    const m = this.workerMeta(key)!;
    return `Attached to ${key} (${m.profile} in ${m.cwd}). Your messages now go to it and its replies come here; /stop, /new, /model, /status apply to it. /detach to return.`;
  }

  /** Tell the worker's owner a human was driving it (so it doesn't assume nothing changed). */
  private noteHumanDone(key: string) {
    const owner = this.workerMeta(key)?.owner;
    if (owner && this.deps.store.getSession(owner)) {
      this.deps.store.pushPending(owner, "peer-result", { label: `a human was driving ${key} and has detached`,
        text: "They may have changed files or given it new instructions; ask it for a summary before relying on earlier results." });
    }
  }

  /** `uniqlaw attach`: hold the worker for a human in a terminal and say how to get in.
   *  live (claude-tmux): attach to the running process. Otherwise the session is closed and the
   *  provider's own CLI resumes the same conversation; the daemon resumes it after release(). */
  async takeover(key: string, by = "terminal"): Promise<TakeoverInfo> {
    const k = this.workerMeta(key) || this.runtimes.has(key) || this.deps.store.getSession(key) ? key
      : this.workerMeta(WORKER_PREFIX + key) ? WORKER_PREFIX + key : undefined;
    if (!k) throw new Error(`unknown session or worker "${key}" (see uniqlaw workers / uniqlaw status)`);
    const held = this.heldBy(k);
    if (held) throw new Error(`${k} is already held by ${held}`);
    const rt = this.runtime(k);
    const provider = this.deps.providers.get(rt.profile.provider)!;
    const cwd = this.deps.store.get(`session-cwd:${k}`) ?? this.deps.projectDir;
    if (provider.attachCommand && !this.deps.store.getSession(k)?.providerSessionId) await rt.ensureOpen();
    const row = this.deps.store.getSession(k);
    const cmd = provider.attachCommand?.({ instanceId: this.deps.instanceId, sessionId: k, providerSessionId: row?.providerSessionId ?? undefined, cwd, profile: rt.profile });
    if (!cmd) throw new Error(`${k} (${rt.profile.provider}) can't be taken over in a terminal${provider.attachCommand ? " yet (no conversation to resume — give it a task first)" : ""}; attach from a chat with /attach ${k} instead`);
    if (!cmd.live) {
      if (!this.workerMeta(k)) throw new Error(`${k} is a chat session; only workers can be handed to a terminal (claude-tmux sessions can be attached live)`);
      if (rt.state === "running" || rt.state === "interrupting" || rt.queueLength > 0) throw new Error(`${k} is busy; wait for its turn to finish (or /stop it) before taking over`);
      await rt.close();
    }
    this.deps.store.set(`hold:${k}`, JSON.stringify({ by, live: cmd.live }));
    this.deps.log.info("takeover", { key: k, by, live: cmd.live });
    return { key: k, argv: cmd.argv, cwd, live: cmd.live, ...(cmd.env ? { env: cmd.env } : {}) };
  }

  release(key: string): boolean {
    const k = this.terminalHold(key) ? key : WORKER_PREFIX + key;
    if (!this.terminalHold(k)) return false;
    this.deps.store.del(`hold:${k}`);
    this.noteHumanDone(k);
    this.deps.log.info("takeover released", { key: k });
    return true;
  }

  isBusy(channelKey: string): boolean {
    const st = this.runtimes.get(channelKey)?.state;
    return st === "running" || st === "interrupting";
  }

  parseTargetString(s: string): Target | undefined {
    const [p] = s.split(":");
    return p ? this.deps.platforms.get(p)?.parseTarget(s) : undefined;
  }

  private targetForChannel(key: string): Target | undefined {
    const [p] = key.split(":");
    return p ? this.deps.platforms.get(p)?.parseTarget(key) : undefined;
  }

  private waitTask(taskId: string) {
    return new Promise<{ ok: boolean; text: string }>((resolve) => this.waiters.set(taskId, { resolve }));
  }

  private completeTask(taskId: string, ok: boolean, text: string) {
    this.deps.store.updateTask(taskId, ok ? "completed" : "failed", text);
    const w = this.waiters.get(taskId);
    this.waiters.delete(taskId);
    w?.resolve({ ok, text: text || "(empty reply)" });
  }

  private deliverAsyncResult(asker: string, answerer: string, taskId: string, hop: number, r: { ok: boolean; text: string }) {
    // CLI / API callers ("cli", "api") are not sessions: the result stays in the task (task_status).
    if (!this.runtimes.has(asker) && !this.deps.store.getSession(asker)) return;
    if (this.workerMeta(asker) && this.heldBy(asker)) {
      // Don't reopen / interrupt a worker a human is driving: it reads the result on its next turn.
      this.deps.store.pushPending(asker, "peer-result", { label: `result of your agent_ask ${taskId} to ${answerer}${r.ok ? "" : " (failed)"}`, text: r.text });
      return;
    }
    // The result turn keeps the ask's hop, so ask → result → ask ping-pong still hits maxHops.
    void this.runtime(asker).enqueue({
      origin: { kind: "peer", fromSession: answerer, hop, mode: "result", taskId },
      item: { text: r.text, receivedAt: Date.now(), sourceLine: `[Result of your agent_ask ${taskId} to ${answerer}${r.ok ? "" : " (failed)"}]`, raw: true },
      attachments: [],
    }).catch((e) => this.deps.log.error("async result delivery failed", { e: String(e) }));
  }

  private async cleanupIdle(maxIdleMs: number) {
    const now = Date.now();
    for (const rt of this.runtimes.values()) {
      if (rt.state === "idle" && rt.queueLength === 0 && now - rt.idleSince() > maxIdleMs) {
        this.deps.log.info("closing idle session", { key: rt.channelKey });
        await rt.close();
      }
    }
  }
}

/** `~` expansion, then relative paths against base. */
function absPath(p: string, base: string): string {
  const e = p === "~" ? process.env.HOME ?? p : expandHome(p);
  return isAbsolute(e) ? e : resolve(base, e);
}
