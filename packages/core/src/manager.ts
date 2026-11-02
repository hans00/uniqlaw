// Owns all ChannelRuntimes: inbound routing, core slash commands, the message
// bus (agents_list / agent_ask / agent_trigger / notify) and idle cleanup.
import type { AgentProvider, Profile } from "./provider.ts";
import type { RemoteAgent } from "./plugin.ts";
import type { InboundMessage, PlatformAdapter, Target } from "./platform.ts";
import type { Origin } from "./origin.ts";
import { ChannelRuntime, type RuntimeHost } from "./runtime.ts";
import { renderSourceLine } from "./format.ts";
import { EventEmitter } from "node:events";
import type { RuntimeEvent, TranscriptStore } from "./transcript.ts";

export interface ManagerDeps extends Omit<RuntimeHost, "onTaskResult" | "platform" | "operatorTargets" | "emit"> {
  providers: Map<string, AgentProvider>;
  platforms: Map<string, PlatformAdapter>;
  profiles: Map<string, Profile>;
}

export interface AgentInfo {
  name: string;
  profile: string;
  provider: string;
  state: string;
  multiparty: boolean;
  lastActivityAt: number;
  queue: number;
}

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

  profileFor(channelKey: string): Profile {
    const name = this.profileOverride.get(channelKey) ?? this.deps.settings.bindings.channels[channelKey] ?? this.deps.settings.bindings.default;
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
      try { this.runtime(row.channelKey, row.multiparty); } catch (e) { this.deps.log.warn("restore skipped", { key: row.channelKey, e: String(e) }); }
    }
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  async handleInbound(msg: InboundMessage): Promise<void> {
    const rt = this.runtime(msg.channelKey, msg.multiparty);
    const platform = this.deps.platforms.get(msg.platform);
    const reply = (t: string) => platform?.send({ ...msg.replyTarget, replyToMessageId: msg.ref.messageId }, t);
    if (msg.trusted && rt.tryConsumeAwaitedInput(msg.text)) { await reply("✅ Sent to the agent."); return; }

    const cmd = msg.text.trim().match(/^\/(stop|new|status|model)(?:@\S+)?(?:\s+(.+))?$/i);
    if (cmd && msg.trusted) {
      const [, name, arg] = cmd;
      switch (name!.toLowerCase()) {
        case "stop": await reply((await rt.stop()) ? "⏹ Stopped." : "Nothing running."); return;
        case "new": await rt.reset(); await reply("🆕 Started a new session."); return;
        case "status": await reply(this.statusText(msg.channelKey)); return;
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
    ].join("\n");
  }

  // ── bus ──────────────────────────────────────────────────────────────────

  listAgents(): AgentInfo[] {
    const keys = new Set([...this.deps.store.listSessions().map((s) => s.channelKey), ...this.runtimes.keys()]);
    return [...keys].map((k): AgentInfo => {
      const rt = this.runtimes.get(k);
      const row = this.deps.store.getSession(k);
      return { name: k, profile: rt?.profile.name ?? row?.profile ?? "?", provider: rt?.profile.provider ?? row?.provider ?? "?",
        state: rt?.state ?? "closed", multiparty: rt?.multiparty ?? row?.multiparty ?? false,
        lastActivityAt: row?.lastActivityAt ?? 0, queue: rt?.queueLength ?? 0 };
    }).concat([...this.remotes.values()].map((r): AgentInfo => ({ name: r.name, profile: r.description ?? "remote", provider: r.name.split(":")[0] ?? "remote",
      state: "remote", multiparty: false, lastActivityAt: 0, queue: 0 })));
  }

  private checkHop(from: string): number {
    const hop = (this.runtimes.get(from)?.currentHop() ?? 0) + 1;
    if (hop > this.deps.settings.bus.maxHops) throw new Error(`delegation chain too deep (hop ${hop} > ${this.deps.settings.bus.maxHops}); answer directly instead`);
    return hop;
  }

  private resolveAgent(to: string): string {
    if (this.runtimes.has(to) || this.deps.store.getSession(to)) return to;
    // Accept v2 peer names (claudeclaw-discord-123) and "uniqlaw-<key>" forms.
    const m = to.match(/^(?:claudeclaw|uniqlaw)-(.+)$/);
    if (m) {
      const k = m[1]!.replace(/^(telegram|discord|slack|line)-/, "$1:");
      if (this.runtimes.has(k) || this.deps.store.getSession(k) || k === "global") return k;
    }
    if (to === "global") return to;
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

  /** Scheduled turn (cron / heartbeat). deliverTo is a target string like "telegram:<chatId>". */
  async fireScheduled(o: { channelKey: string; job: string; text: string; sourceLine: string; deliverTo?: string; raw?: boolean }) {
    const deliverTo = o.deliverTo ? this.parseTargetString(o.deliverTo) : undefined;
    if (o.deliverTo && !deliverTo) this.deps.log.warn("scheduled job has an unresolvable replyTo; output follows backgroundNotify", { job: o.job, replyTo: o.deliverTo });
    await this.runtime(o.channelKey).enqueue({
      origin: { kind: "scheduler", job: o.job, deliverTo },
      item: { text: o.text, receivedAt: Date.now(), sourceLine: o.sourceLine, raw: o.raw },
      attachments: [],
    });
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
