// Owns all ChannelRuntimes: inbound routing, core slash commands, the message
// bus (agents_list / agent_ask / agent_trigger / notify) and idle cleanup.
import type { AgentProvider, Profile, TurnInput } from "./provider.ts";
import type { InboundRequest, RemoteAgent, ScheduledFire, Transcriber } from "./plugin.ts";
import type { InboundMessage, OutboundFile, PlatformAdapter, Target } from "./platform.ts";
import type { Origin } from "./origin.ts";
import type { GroupMode } from "./config.ts";
import { ChannelRuntime, type QueuedInput, type RuntimeHost } from "./runtime.ts";
import { PairingService } from "./pairing.ts";
import { resolveToolPolicy, type ToolPolicy } from "./channel-policy.ts";
import { A2A_TOOL_POLICY, a2aPermissions, a2aSessionDir, a2aSessionKey, isA2ASession } from "./a2a-policy.ts";
import { formatTimestamp, isPassthroughSlashCommand, renderSourceLine } from "./format.ts";
import { EventEmitter } from "node:events";
import type { RuntimeEvent, TranscriptStore } from "./transcript.ts";
import { realpathSync, statSync } from "node:fs";
import { expandHome } from "./credentials.ts";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export interface ManagerDeps extends Omit<RuntimeHost, "onTaskResult" | "onUsageLimit" | "platform" | "operatorTargets" | "emit" | "isInternal" | "cwdFor" | "workerOf" | "backgroundTarget" | "toolPolicyFor" | "isolation" | "deferInput"> {
  providers: Map<string, AgentProvider>;
  platforms: Map<string, PlatformAdapter>;
  profiles: Map<string, Profile>;
  /** Transcriber named by settings.transcription.engine (absent = agents get the audio file only). */
  transcriber?: Transcriber;
  /** Parent of the inbound A2A session directories (default: the system temp dir). Tests point it elsewhere. */
  a2aSessionsBase?: string;
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

/** A turn that failed on the usage limit (re-sent after a profile switch). */
type FailedTurn = { origins: Origin[]; input?: TurnInput };
/** A chat's provider session on a profile it switched away from (resumed when it switches back). */
interface SavedProfileSession { provider: string; providerSessionId: string; adapterState: string | null; transcriptId: number }

const HANDOFF_BLOCK_RE = /\[(?:Handover: this chat|While you were away, this chat)[\s\S]*?\[End of transcript\]\s*/g;

/** Providers that can continue each other's sessions natively. */
function sharesSessions(a: string, b: string): boolean {
  const claude = new Set(["claude-tmux", "claude-sdk"]);
  return a === b || (claude.has(a) && claude.has(b));
}
const WORKER_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** How a human takes over a session in a terminal (provider-specific). */
export interface TakeoverInfo { key: string; argv: string[]; cwd: string; live: boolean;
  /** Non-secret env the command needs (e.g. CLAUDE_CONFIG_DIR for an alternate login). */
  env?: Record<string, string> }

export type GroupSettings = { mode: GroupMode; ignoreOtherMentions: boolean; historyLimit: number; allowFrom: string[]; others: "context" | "ignore" };

/** `merged`: an async ask whose turn's answer went out with an earlier ask from the same session (no delivery of
 *  its own). A blocking ask has no `merged` and resolves with the pointer text. */
type TaskWaiter = { resolve: (r: { ok: boolean; text: string }) => void; merged?: () => void };

/** A turn still in flight (graceful restart bookkeeping). */
export interface InflightTurn { channelKey: string; origins: Origin[]; detachable: boolean; inputs: QueuedInput[] }

/** A task the previous daemon left open and that could not be resumed. */
export interface FailedTask { taskId: string; from: string; to: string; mode: "ask" | "trigger" }

/** Without a restart record (crash), open tasks not updated for this long are failed quietly: they predate it. */
const STALE_TASK_MS = 3600_000;
export const RESTART_TASK_FAILURE = "interrupted: the UniQlaw daemon restarted before it finished";

export class ChannelManager {
  readonly runtimes = new Map<string, ChannelRuntime>();
  /** Live runtime events ("event" → RuntimeEvent) for dashboards. */
  readonly events = new EventEmitter();
  private remotes = new Map<string, RemoteAgent>();
  /** channelKey → profile override (A2A sessions run on the profile they were addressed to). */
  private profileOverride = new Map<string, string>();
  /** Inbound A2A sessions (by key): the exposed profile's prompt, and whether the operator allowed a non-isolating
   *  provider. In memory only: after a restart a session stays fail-closed until its caller's next request. */
  private a2aPrompt = new Map<string, string>();
  private a2aUnsafe = new Set<string>();
  private waiters = new Map<string, TaskWaiter>();
  /** Usage-limit fallback offers waiting for the owner, per chat: the failed turns to re-send after a switch. */
  private pendingSwitch = new Map<string, { failed: FailedTurn[]; until: number }>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly host: RuntimeHost;
  /** DM pairing (strangers get a code; operators approve). */
  readonly pairing: PairingService;
  /** Set while the daemon drains for a restart: new input is persisted (deferred_input) instead of starting turns. */
  private draining?: { since: number; acked: Set<string> };

  constructor(private readonly deps: ManagerDeps) {
    this.host = {
      ...deps,
      platform: (n) => deps.platforms.get(n),
      operatorTargets: () => [...deps.platforms.values()].flatMap((p) => p.operatorTargets()),
      onTaskResult: (id, ok, text, opts) => this.completeTask(id, ok, text, opts?.mergedInto),
      onUsageLimit: (key, failed) => this.onUsageLimit(key, failed),
      emit: (ev: RuntimeEvent) => { this.events.emit("event", ev); },
      isInternal: (k) => this.kindOf(k) === "internal",
      // Inbound A2A sessions run in an empty directory of their own, never in the project.
      cwdFor: (k) => isA2ASession(k) ? a2aSessionDir(deps.instanceId, k, deps.a2aSessionsBase) : deps.store.get(`session-cwd:${k}`),
      isolation: (k) => isA2ASession(k) ? { unsafeProvider: this.a2aUnsafe.has(k), ...(this.a2aPrompt.has(k) ? { prompt: this.a2aPrompt.get(k)! } : {}) } : undefined,
      toolPolicyFor: (k) => this.toolPolicy(k),
      workerOf: (k) => { const m = this.workerMeta(k); return m ? { owner: m.owner } : undefined; },
      deferInput: (k, input) => this.deferInput(k, input),
      releaseDeferred: (ids) => deps.store.deleteDeferred(ids),
      backgroundTarget: (k) => {
        if (!k.startsWith(WORKER_PREFIX)) return undefined;
        // Workers have no chat: background output (e.g. a human typing in its terminal) goes to the
        // chat attached to it, else nowhere (it stays in the transcript).
        const chat = this.attachedChat(k);
        return (chat ? this.targetForChannel(chat) : undefined) ?? null;
      },
    };
    this.events.setMaxListeners(100);
    this.pairing = new PairingService({ store: deps.store, settings: deps.settings, platforms: deps.platforms, log: deps.log });
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

  /** Tool policy of a session. Chats: their channel capabilities (settings.channels). Inbound A2A sessions: the
   *  fixed deny-by-default A2A_TOOL_POLICY, whatever settings.channels says. Internal sessions (cron jobs, heartbeat)
   *  and workers keep their own settings (unrestricted), also when they post into a chat. */
  toolPolicy(channelKey: string): ToolPolicy | undefined {
    if (isA2ASession(channelKey)) return A2A_TOOL_POLICY;
    return this.kindOf(channelKey) === "chat" ? resolveToolPolicy(this.deps.settings.channels, channelKey) : undefined;
  }

  profileFor(channelKey: string): Profile {
    // An A2A session's key names its profile (a2a:<profile>:…), which also holds for sessions restored after a restart.
    const a2aProfile = isA2ASession(channelKey) ? channelKey.split(":")[1] : undefined;
    const name = this.profileOverride.get(channelKey) ?? a2aProfile ?? this.pinnedProfile(channelKey)
      ?? this.deps.settings.bindings.channels[channelKey] ?? this.deps.settings.bindings.default;
    const p = this.deps.profiles.get(name);
    if (!p) throw new Error(`channel ${channelKey} is bound to unknown profile "${name}"`);
    // A remote caller drives inbound A2A sessions: deny-by-default whatever the profile allows (a2a-policy.ts).
    return isA2ASession(channelKey) ? { ...p, permissions: a2aPermissions(p.permissions) } : p;
  }

  /** A provider's permission hook (claude-tmux `PermissionRequest`): the session's judge stage on structured input.
   *  undefined = defer to the provider's own dialog (no live session, judge off or escalated). */
  async permissionHook(channelKey: string, req: { tool: string; input: unknown }) {
    return this.runtimes.get(channelKey)?.permissionHook(req);
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
      try {
        const rt = this.runtime(row.channelKey, row.multiparty);
        // It was mid-turn when the daemon stopped: reattach now so the reply is delivered, not at the next message.
        if (this.deps.store.get(`inflight-turn:${row.channelKey}`)) void rt.ensureOpen();
      } catch (e) { this.deps.log.warn("restore skipped", { key: row.channelKey, e: String(e) }); }
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
    const prof = msg.text.trim().match(/^\/profile(?:@\S+)?(?:\s+(\S+))?\s*$/i);
    if (prof && msg.trusted) { await reply(await this.profileCommand(sessionKey, prof[1])); return; }
    const pair = msg.text.trim().match(/^\/pair(?:@\S+)?(?:\s+(.+))?$/i);
    if (pair && msg.trusted) { await reply(await this.pairing.command(pair[1])); return; }
    const act = msg.text.trim().match(/^\/activation(?:@\S+)?(?:\s+(\S+))?\s*$/i);
    if (act && msg.trusted && msg.multiparty) { await reply(this.activationCommand(msg.channelKey, act[1]?.toLowerCase())); return; }
    const wake = msg.multiparty ? this.wakeCheck(msg) : "wake";
    if (wake !== "wake") {
      const g = this.groupSettings(msg.channelKey, msg.groupPolicy);
      if (g.others === "context" && g.historyLimit > 0) {
        const extra = msg.attachments.length ? ` [+${msg.attachments.length} attachment(s), not shown]` : "";
        const label = wake === "not-allowed" ? `${msg.sender.name} [id ${msg.sender.id}] (not allowed to wake you; background only)` : `${msg.sender.name} (not addressed to you)`;
        this.deps.store.pushPending(sessionKey, "group-context", { label, text: msg.text + extra });
        this.deps.store.trimPending(sessionKey, "group-context", g.historyLimit);
      }
      return;
    }
    const origin: Origin = { kind: "human", platform: msg.platform, channelKey: msg.channelKey, sender: msg.sender,
      replyTarget: msg.replyTarget, ref: msg.ref, trusted: msg.trusted };
    const transcript = await this.transcribe(rt, msg.attachments);
    await rt.enqueue({
      origin,
      item: { text: [msg.text, transcript].filter(Boolean).join("\n\n"), receivedAt: msg.receivedAt, sourceLine: renderSourceLine(msg.platform, msg.sender) },
      attachments: msg.attachments,
    });
  }

  // ── profile switching (/profile, usage-limit fallback) ───────────────────

  private bindingProfile(channelKey: string): string {
    return this.deps.settings.bindings.channels[channelKey] ?? this.deps.settings.bindings.default;
  }

  private async profileCommand(channelKey: string, arg?: string): Promise<string> {
    const cur = this.profileFor(channelKey);
    const list = [...this.deps.profiles.values()].map((p) => `${p.name === cur.name ? "▸ " : "  "}${p.name} (${p.provider}${p.model ? ` · ${p.model}` : ""})`);
    if (!arg) return [`Profile: **${cur.name}** (${cur.provider}). Default for this chat: ${this.bindingProfile(channelKey)}.`, ...list, "Switch with /profile <name>; /profile reset goes back to the default."].join("\n");
    const name = arg.toLowerCase() === "reset" ? this.bindingProfile(channelKey) : arg;
    try {
      const r = await this.switchProfile(channelKey, name);
      return r.changed ? `🔀 Switched to **${name}** (${r.provider})${r.how === "native" ? " — same conversation." : r.how === "resumed" ? " — resumed its earlier session, with what happened meanwhile." : " — handed the conversation over as a transcript."}${r.resent ? ` Re-sending ${r.resent} message(s) that hit the usage limit.` : ""}`
        : `Already on **${name}**.`;
    } catch (e) { return `⚠️ ${e instanceof Error ? e.message : String(e)}`; }
  }

  /**
   * Move a chat to another profile. The conversation follows:
   *  - native: same provider (or claude-tmux ↔ claude-sdk) → the provider session id is carried over;
   *  - resumed: the target profile has a session from before → resume it and add the turns that ran elsewhere;
   *  - handoff: otherwise a fresh session gets the raw transcript (newest first within profileSwitch.handoffMaxChars).
   * Turns that failed on the usage limit (pending offer) are re-sent on the new profile.
   */
  async switchProfile(channelKey: string, name: string): Promise<{ changed: boolean; provider: string; how?: "native" | "resumed" | "handoff"; resent?: number }> {
    const target = this.deps.profiles.get(name);
    if (!target) throw new Error(`unknown profile "${name}"`);
    if (!this.deps.providers.has(target.provider)) throw new Error(`profile "${name}" uses provider "${target.provider}", which is not loaded`);
    const old = this.profileFor(channelKey);
    const rt = this.runtime(channelKey);
    if (old.name === name) return { changed: false, provider: target.provider };
    if (rt.state === "running" || rt.state === "interrupting") throw new Error("the agent is busy; /stop it first");
    const failed = this.pendingSwitch.get(channelKey)?.failed ?? [];
    this.pendingSwitch.delete(channelKey);

    const row = this.deps.store.getSession(channelKey);
    const lastId = this.deps.transcript?.list(channelKey, 1).at(-1)?.id ?? 0;
    if (row?.providerSessionId) {
      this.deps.store.set(`profile-session:${channelKey}:${old.name}`, JSON.stringify({ provider: row.provider, providerSessionId: row.providerSessionId,
        adapterState: row.adapterState, transcriptId: lastId } satisfies SavedProfileSession));
    }
    const savedRaw = this.deps.store.get(`profile-session:${channelKey}:${name}`);
    const saved = savedRaw ? JSON.parse(savedRaw) as SavedProfileSession : undefined;
    const native = !!row?.providerSessionId && sharesSessions(old.provider, target.provider);
    const how = native ? "native" : saved && saved.provider === target.provider ? "resumed" : "handoff";

    const queued = rt.takeQueue();
    await rt.close();
    this.runtimes.delete(channelKey);
    if (name === this.bindingProfile(channelKey)) this.deps.store.del(`session-profile:${channelKey}`);
    else this.deps.store.set(`session-profile:${channelKey}`, name);
    const now = Date.now();
    this.deps.store.upsertSession({
      channelKey, profile: name, provider: target.provider,
      providerSessionId: how === "native" ? row!.providerSessionId : how === "resumed" ? saved!.providerSessionId : null,
      multiparty: row?.multiparty ?? false, createdAt: row?.createdAt ?? now, lastActivityAt: now, lastTarget: row?.lastTarget ?? null,
      adapterState: how === "native" && row!.provider === target.provider ? row!.adapterState : how === "resumed" ? saved!.adapterState : null,
    });
    // Leave out the turns that are about to be re-sent (they failed; their prompts are in the transcript too).
    const failedTexts = new Set(failed.map((f) => f.input?.text).filter(Boolean));
    if (how !== "native") {
      const block = this.handoffBlock(channelKey, { from: old, to: target, afterId: how === "resumed" ? saved!.transcriptId : 0, resumed: how === "resumed", skip: failedTexts });
      if (block) this.deps.store.pushPending(channelKey, "handoff", { text: block });
    }
    this.deps.log.info("profile switched", { key: channelKey, from: old.name, to: name, how });
    const next = this.runtime(channelKey);
    for (const f of failed) {
      const human = [...f.origins].reverse().find((o) => o.kind === "human");
      if (!human || !f.input) continue;
      await next.enqueue({ origin: human, item: { text: f.input.text, receivedAt: Date.now(), sourceLine: "[Re-sent: this hit the usage limit of the previous profile]", raw: true },
        attachments: f.input.attachments });
    }
    for (const q of queued) await next.enqueue(q);
    return { changed: true, provider: target.provider, how, ...(failed.length ? { resent: failed.length } : {}) };
  }

  /** Raw transcript (oldest first) for a profile that takes over a chat; undefined if there is nothing to hand over. */
  private handoffBlock(channelKey: string, o: { from: Profile; to: Profile; afterId: number; resumed: boolean; skip: Set<string | undefined> }): string | undefined {
    const t = this.deps.transcript;
    if (!t) return undefined;
    const tz = this.deps.settings.timezone;
    const entries = t.list(channelKey, 500, o.afterId).filter((e) => e.kind === "prompt" || e.kind === "assistant" || e.kind === "tool" || e.kind === "permission");
    // Drop the trailing failed turn(s): they are re-sent as new messages.
    while (entries.length && entries.at(-1)!.kind === "prompt" && o.skip.has(entries.at(-1)!.text)) entries.pop();
    if (!entries.length) return undefined;
    const label = { prompt: "incoming", assistant: "assistant", tool: "tool", permission: "permission" } as Record<string, string>;
    const blocks: string[] = [];
    let used = 0;
    let omitted = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      // A prompt may itself carry an earlier handover block: the target already has (or never needs) that.
      const text = e.kind === "prompt" ? e.text.replace(HANDOFF_BLOCK_RE, "").trim() : e.text;
      if (!text) continue;
      const b = `--- ${label[e.kind]} · ${formatTimestamp(new Date(e.at), tz)} ---\n${text}`;
      if (used + b.length > this.deps.settings.profileSwitch.handoffMaxChars) { omitted = i + 1; break; }
      blocks.unshift(b);
      used += b.length;
    }
    const head = o.resumed
      ? `[While you were away, this chat ran on profile "${o.from.name}" (${o.from.provider}). Below is what happened since your last turn, raw, oldest first. Already-answered messages need no reply.]`
      : `[Handover: this chat was running on profile "${o.from.name}" (${o.from.provider}) and now runs on you ("${o.to.name}", ${o.to.provider}). Below is the conversation so far, raw, oldest first — continue it. Already-answered messages need no reply.]`;
    return [head, ...(omitted ? [`[${omitted} earlier entries omitted]`] : []), ...blocks, "[End of transcript]"].join("\n\n");
  }

  /** Usage limit: the owner is asked whether to switch profile; anyone else just gets the error (runtime posts it). */
  private async onUsageLimit(channelKey: string, failed: FailedTurn): Promise<boolean> {
    const human = [...failed.origins].reverse().find((o): o is Extract<Origin, { kind: "human" }> => o.kind === "human");
    if (!human?.trusted) return false;
    const cur = this.profileFor(channelKey);
    const candidates = (cur.fallback?.length ? cur.fallback : [...this.deps.profiles.keys()])
      .filter((n) => n !== cur.name && this.deps.profiles.has(n) && this.deps.providers.has(this.deps.profiles.get(n)!.provider));
    if (!candidates.length) return false;
    const open = this.pendingSwitch.get(channelKey);
    if (open && open.until > Date.now()) { open.failed.push(failed); return true; } // already asked; re-send this one too
    const ttl = 30 * 60_000;
    this.pendingSwitch.set(channelKey, { failed: [failed], until: Date.now() + ttl });
    const platform = this.deps.platforms.get(human.platform);
    const title = `⛔ Profile "${cur.name}" (${cur.provider}) hit its usage limit.`;
    if (!platform?.askChoice) {
      await platform?.send(human.replyTarget, `${title} Switch this chat with /profile <name> (${candidates.join(", ")}); your message is re-sent there.`);
      return true;
    }
    void platform.askChoice(human.replyTarget, {
      title, body: "Switch this chat to another profile? The conversation is handed over and your message is re-sent. /profile switches back later.",
      options: [...candidates.map((c) => `Switch to ${c}`), "Not now"], approverIds: [human.sender.id], timeoutMs: ttl,
    }).then(async (choice) => {
      const name = choice !== null ? candidates[choice] : undefined;
      if (!name) {
        if (this.pendingSwitch.get(channelKey)?.failed.includes(failed)) this.pendingSwitch.delete(channelKey);
        await platform.send(human.replyTarget, "OK — staying on this profile. Try again later, or /profile <name> to switch.");
        return;
      }
      await platform.send(human.replyTarget, await this.profileCommand(channelKey, name));
    }).catch((e) => this.deps.log.warn("usage-limit offer failed", { key: channelKey, e: String(e) }));
    return true;
  }

  /** Transcripts of voice/audio attachments, as text for the prompt (best-effort: failures only log). */
  private async transcribe(rt: ChannelRuntime, attachments: InboundMessage["attachments"]): Promise<string> {
    const t = this.deps.transcriber;
    const cfg = this.deps.settings.transcription;
    if (!t) return "";
    if (cfg.when === "unsupported" && rt.capabilities.attachments.includes("audio")) return "";
    const out: string[] = [];
    for (const a of attachments) {
      if (a.kind !== "voice" && a.kind !== "audio") continue;
      if (a.durationSec && a.durationSec > cfg.maxSeconds) { out.push(`[${a.kind} not transcribed: ${a.durationSec}s is over transcription.maxSeconds]`); continue; }
      const started = Date.now();
      try {
        const text = (await t.transcribe({ path: a.path, ...(a.mime ? { mime: a.mime } : {}), ...(cfg.language !== "auto" ? { language: cfg.language } : {}) })).trim();
        this.deps.log.info("transcribed", { engine: cfg.engine, ms: Date.now() - started, chars: text.length });
        out.push(`[${a.kind === "voice" ? "Voice message" : "Audio"} transcript${a.name ? ` (${a.name})` : ""}: ${text || "(no speech)"}]`);
      } catch (e) {
        this.deps.log.warn("transcription failed; the agent gets the file only", { engine: cfg.engine, path: a.path, e: String(e) });
      }
    }
    return out.join("\n");
  }

  /** Group settings for a channel: `/activation` override, then `groups.channels` (a Slack thread key falls back
   *  to its channel), then `groups` defaults. */
  groupSettings(channelKey: string, platformPolicy?: InboundMessage["groupPolicy"]): GroupSettings {
    const { channels, ...defaults } = this.deps.settings.groups;
    const parts = channelKey.split(":");
    let entry: Partial<typeof defaults> | undefined;
    for (let n = parts.length; n >= 2 && !entry; n--) entry = channels[parts.slice(0, n).join(":")];
    const override = this.deps.store.get(`group-mode:${channelKey}`) as GroupMode | undefined;
    // allowFrom entries are "<platform>:<id>". In a per-channel entry a bare id means that channel's platform; in the
    // global list a bare id matches no one (it would mean different people on different platforms), so a list of
    // only bare ids fails closed. channelPolicyWarnings reports them at startup.
    const allowFrom = entry?.allowFrom ? entry.allowFrom.map((a) => (a.includes(":") ? a : `${parts[0]}:${a}`)) : defaults.allowFrom;
    return { ...defaults, ...platformPolicy, ...entry, allowFrom, ...(override ? { mode: override } : {}) };
  }

  /** Multiparty gate: does this message start a turn, or only become context? The sender check uses the
   *  platform's user id from the payload (never a name, never the message text). */
  private wakeCheck(msg: InboundMessage): "wake" | "not-addressed" | "not-allowed" {
    const g = this.groupSettings(msg.channelKey, msg.groupPolicy);
    if (g.allowFrom.length && !g.allowFrom.includes(`${msg.platform}:${msg.sender.id}`)) return "not-allowed";
    const addressed = msg.addressed ?? true; // an adapter that can't tell must not produce a bot that never answers
    if (addressed) return "wake";
    if (g.mode === "mention") return "not-addressed";
    return g.ignoreOtherMentions && msg.mentionsOthers ? "not-addressed" : "wake";
  }

  private activationCommand(channelKey: string, arg?: string): string {
    if (arg === "mention" || arg === "always") {
      this.deps.store.set(`group-mode:${channelKey}`, arg);
      return arg === "mention" ? "🔕 I'll answer only when mentioned or replied to; other messages are kept as context."
        : "🔔 I'll read every message and answer when I have something to add.";
    }
    if (arg === "reset" || arg === "default") {
      this.deps.store.del(`group-mode:${channelKey}`);
      return `↩️ Back to the configured mode: ${this.groupSettings(channelKey).mode}.`;
    }
    return `Activation: ${this.groupSettings(channelKey).mode}. Use /activation mention | always | reset.`;
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

  /** Rounds of the result an ask from `from` would bring back (see Origin.rounds). */
  private checkRounds(from: string): number {
    const rounds = (this.runtimes.get(from)?.currentRounds() ?? 0) + 1;
    const max = this.deps.settings.bus.maxRounds;
    if (rounds > max) throw new Error(`too many agent_ask rounds without a human message (${rounds} > ${max}); report back instead`);
    return rounds;
  }

  /** Outstanding async tasks per asking session (bus.maxPending) and calls per delegation chain (bus.maxChainTasks). */
  private pendingAsync = new Map<string, number>();
  private chainUse = new Map<string, number>();

  /** Fan-out limits for a delegation call from `from`; throws before anything is sent. The caller must run
   *  `commit()` once it goes ahead, and (async calls) `release()` exactly once when the task's result is in. */
  private admitFanOut(from: string, async: boolean) {
    const { maxPending, maxChainTasks } = this.deps.settings.bus;
    const chain = this.runtimes.get(from)?.currentChain() ?? `caller:${from}:${crypto.randomUUID()}`;
    const used = this.chainUse.get(chain) ?? 0;
    if (used + 1 > maxChainTasks) throw new Error(`delegation budget used up: this chain already made ${used} agent_ask/agent_trigger/worker_start calls (max ${maxChainTasks}); answer directly instead`);
    const pending = this.pendingAsync.get(from) ?? 0;
    if (async && pending + 1 > maxPending) throw new Error(`too many outstanding async tasks (${pending}, max ${maxPending}); wait for their results (task_status) before starting more`);
    let released = !async;
    return {
      chain,
      commit: () => {
        this.chainUse.delete(chain); // re-insert: Map order = least recently used first
        this.chainUse.set(chain, used + 1);
        if (this.chainUse.size > 2000) this.chainUse.delete(this.chainUse.keys().next().value!);
        if (async) this.pendingAsync.set(from, (this.pendingAsync.get(from) ?? 0) + 1);
      },
      release: () => {
        if (released) return;
        released = true;
        const n = (this.pendingAsync.get(from) ?? 1) - 1;
        if (n > 0) this.pendingAsync.set(from, n); else this.pendingAsync.delete(from);
      },
    };
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
    // A blocking ask that would only be answered after the restart: refuse now instead of hanging the caller.
    if (wait && this.draining && !this.isBusy(from)) throw new Error("UniQlaw is restarting; ask again in a moment (or use wait=false: it runs after the restart)");
    const rounds = wait ? 0 : this.checkRounds(from);
    const fan = this.admitFanOut(from, !wait);
    const { chain } = fan;
    const taskId = crypto.randomUUID();
    this.deps.store.createTask({ taskId, fromSession: from, toSession: target, mode: "ask", request: message });
    fan.commit();
    const done = wait ? this.waitTask(taskId) : undefined;
    if (!wait) this.waiters.set(taskId, this.asyncWaiter("ask", from, target, taskId, { hop: hop - 1, rounds, chain }, fan.release));
    try {
      await this.runtime(target).enqueue({
        // rounds/chain ride on the ask too, so a task re-armed after a restart answers with the same budget.
        origin: { kind: "peer", fromSession: from, hop, rounds, mode: "ask", taskId, chain, rootTarget: this.runtimes.get(from)?.rootTarget() },
        item: { text: message, receivedAt: Date.now(), sourceLine: `[Agent message from session ${from} — reply here; your reply is returned to that agent, no human sees it]`, raw: true },
        attachments: [],
      });
    } catch (e) { fan.release(); throw e; }
    this.deps.store.updateTask(taskId, "working");
    if (!done) return { taskId };
    const timeout = this.deps.settings.bus.askTimeoutSec * 1000;
    const result = await Promise.race([done, new Promise<{ ok: boolean; text: string }>((r) => setTimeout(() => r({ ok: false, text: `timed out after ${timeout / 1000}s; the task keeps running — check task_status(${taskId})` }), timeout))]);
    return { taskId, result };
  }

  private async askRemote(from: string, remote: RemoteAgent, message: string, wait: boolean) {
    const hop = this.checkHop(from);
    const rounds = wait ? 0 : this.checkRounds(from);
    const fan = this.admitFanOut(from, !wait);
    const { chain } = fan;
    const taskId = crypto.randomUUID();
    this.deps.store.createTask({ taskId, fromSession: from, toSession: remote.name, mode: "ask", request: message });
    fan.commit();
    this.deps.store.updateTask(taskId, "working");
    const run = remote.ask({ from, message, hop }).catch((e) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }))
      .then((r) => { this.deps.store.updateTask(taskId, r.ok ? "completed" : "failed", r.text); return r; });
    if (wait) return { taskId, result: await run };
    void run.then((r) => { fan.release(); this.deliverAsyncResult(from, remote.name, taskId, { hop: hop - 1, rounds, chain }, r); });
    return { taskId };
  }

  /** Inbound request from a remote agent (A2A) against a local profile. The session is keyed by the
   *  authenticated caller as well as the contextId: the caller chooses the contextId, so a contextId alone
   *  would let one peer join another peer's conversation. */
  async runInbound(o: InboundRequest): Promise<{ ok: boolean; text: string }> {
    const profile = this.deps.profiles.get(o.profile);
    if (!profile) return { ok: false, text: `unknown profile "${o.profile}"` };
    if (o.hop > this.deps.settings.bus.maxHops) return { ok: false, text: "delegation chain too deep" };
    if (this.draining) return { ok: false, text: "the agent's host is restarting; retry in a minute" };
    // Fail closed before anything is queued (the runtime checks again when it opens the session).
    if (!o.unsafeProvider && !this.deps.providers.get(profile.provider)?.capabilities(profile).isolation) {
      return { ok: false, text: `profile "${o.profile}" runs on a provider that cannot isolate remote requests` };
    }
    const key = a2aSessionKey(o.profile, o.caller, o.contextId);
    this.profileOverride.set(key, o.profile);
    if (o.prompt) this.a2aPrompt.set(key, o.prompt); else this.a2aPrompt.delete(key);
    if (o.unsafeProvider) this.a2aUnsafe.add(key); else this.a2aUnsafe.delete(key);
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
    const fan = this.admitFanOut(from, true);
    const { chain } = fan;
    const rt = this.runtime(target);
    const deliverTo = replyTo ?? rt.lastTarget() ?? this.targetForChannel(target);
    if (!deliverTo) throw new Error(`"${target}" has no chat to answer on; pass replyTo`);
    const taskId = crypto.randomUUID();
    this.deps.store.createTask({ taskId, fromSession: from, toSession: target, mode: "trigger", request: prompt });
    fan.commit();
    this.waiters.set(taskId, this.asyncWaiter("trigger", from, target, taskId, { hop: hop - 1, rounds: 0, chain }, fan.release));
    try {
      await rt.enqueue({
        origin: { kind: "peer", fromSession: from, hop, mode: "trigger", taskId, chain, deliverTo },
        item: { text: prompt, receivedAt: Date.now(), sourceLine: `[Triggered by session ${from} — your reply goes to this channel's chat]`, raw: true },
        attachments: [],
      });
    } catch (e) { fan.release(); throw e; }
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

  /** send_file: post a local file to a chat (default: the caller's own chat) and echo it into the owning session. */
  async sendFile(from: string, o: { path: string; target?: string; caption?: string; kind?: OutboundFile["kind"]; name?: string }): Promise<{ target: string; file: string }> {
    let target: Target | undefined;
    if (o.target) target = this.parseTargetString(o.target);
    else target = this.runtimes.get(from)?.lastTarget() ?? this.targetForChannel(from);
    if (!target) throw new Error(o.target ? `cannot resolve target "${o.target}" (expected e.g. telegram:<chatId>)` : "this session has no chat; pass target");
    const platform = this.deps.platforms.get(target.platform);
    if (!platform?.sendFile) throw new Error(`${target.platform} can't upload files`);
    const real = this.resolveSendablePath(from, o.path);
    const name = o.name?.trim() || basename(real);
    const kind = o.kind ?? kindFromName(name);
    const ref = await platform.sendFile(target, { path: real, name, kind, ...(o.caption ? { caption: o.caption } : {}) });
    if (!ref) throw new Error(`${target.platform} rejected the upload (see daemon log)`);
    const label = `${target.platform}:${target.chatId}${target.threadId ? `:${target.threadId}` : ""}`;
    const owner = platform.channelKeyForTarget(target);
    if (owner !== from) this.deps.store.pushPending(owner, "notify-echo", { label: `sent on your behalf by ${from}`, text: `[${kind}: ${name}]${o.caption ? ` ${o.caption}` : ""}` });
    return { target: label, file: name };
  }

  /** Files an agent may send: inside the project dir, its own cwd, workers.roots, files.roots or the temp dir. */
  private resolveSendablePath(from: string, p: string): string {
    const cwd = this.deps.store.get(`session-cwd:${from}`) ?? this.deps.projectDir;
    let real: string;
    try { real = realpathSync(isAbsolute(expandHome(p)) ? expandHome(p) : resolve(cwd, p)); } catch { throw new Error(`file not found: ${p}`); }
    const st = statSync(real);
    if (!st.isFile()) throw new Error(`not a file: ${p}`);
    const max = this.deps.settings.files.maxMB * 1024 * 1024;
    if (st.size > max) throw new Error(`file is ${(st.size / 1048576).toFixed(1)} MB; the limit is ${this.deps.settings.files.maxMB} MB (settings files.maxMB)`);
    const roots = [this.deps.projectDir, cwd, tmpdir(), ...this.deps.settings.workers.roots, ...this.deps.settings.files.roots].flatMap((r) => {
      try { return [realpathSync(absPath(r, this.deps.projectDir))]; } catch { return []; }
    });
    if (!roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) {
      throw new Error(`${real} is outside the directories files may be sent from (${roots.join(", ")}); the operator can add one to settings files.roots`);
    }
    return real;
  }

  taskStatus(taskId: string) { return this.deps.store.getTask(taskId); }

  /** task_status view: state and result, elapsed time, and while it is open, the answering session's progress. */
  taskReport(taskId: string, now = Date.now()) {
    const t = this.deps.store.getTask(taskId);
    if (!t) return undefined;
    const open = t.state === "submitted" || t.state === "working";
    const progress = open ? this.runtimes.get(t.toSession)?.progressOf(taskId) : undefined;
    return {
      state: t.state, result: t.result,
      elapsedSec: Math.round(((open ? now : t.updatedAt) - t.createdAt) / 1000),
      ...(progress ? { progress: {
        phase: progress.phase,
        ...(progress.queuePosition ? { queuePosition: progress.queuePosition } : {}),
        ...(progress.turnStartedAt ? { turnElapsedSec: Math.round((now - progress.turnStartedAt) / 1000) } : {}),
        ...(progress.latestText ? { latestText: progress.latestText } : {}),
        ...(progress.recent.length ? { recent: progress.recent } : {}),
      } } : {}),
    };
  }

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

  /** Run one turn in an internal session and return its final reply (no chat sees it). Used by plugins that
   *  need a model's answer, e.g. the dreaming sweep. fresh: start a new provider session first, so earlier
   *  turns don't leak into this one. */
  async complete(o: { channelKey: string; text: string; job: string; profile?: string; model?: string; timeoutMs?: number; fresh?: boolean }): Promise<{ ok: boolean; text: string }> {
    if (this.kindOf(o.channelKey) !== "internal") throw new Error(`complete() runs in internal sessions only, not ${o.channelKey}`);
    if (this.isBusy(o.channelKey)) return { ok: false, text: `${o.channelKey} is busy` };
    if (this.draining) return { ok: false, text: "UniQlaw is restarting" };
    if (o.profile) await this.pinProfile(o.channelKey, o.profile, o.job);
    if (o.fresh) await this.runtime(o.channelKey).reset();
    const taskId = crypto.randomUUID();
    this.deps.store.createTask({ taskId, fromSession: `job:${o.job}`, toSession: o.channelKey, mode: "ask", request: o.text });
    const done = this.waitTask(taskId);
    await this.runtime(o.channelKey).enqueue({
      origin: { kind: "scheduler", job: o.job, silent: true, taskId, ...(o.model ? { model: o.model } : {}) },
      item: { text: o.text, receivedAt: Date.now(), sourceLine: `[${o.job}]`, raw: true },
      attachments: [],
    });
    this.deps.store.updateTask(taskId, "working");
    const ms = o.timeoutMs ?? this.deps.settings.bus.askTimeoutSec * 1000;
    return Promise.race([done, new Promise<{ ok: boolean; text: string }>((r) => setTimeout(() => r({ ok: false, text: `timed out after ${ms / 1000}s` }), ms))]);
  }

  /** Leave a note for every open chat session (shown with its next turn), e.g. "MEMORY.md changed". */
  noteToOpenChats(label: string, text: string): number {
    let n = 0;
    for (const [key, rt] of this.runtimes) {
      if (this.kindOf(key) !== "chat" || rt.state === "closed") continue;
      this.deps.store.pushPending(key, "peer-result", { label, text });
      n++;
    }
    return n;
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
    return this.runtimes.get(channelKey)?.busy ?? false;
  }

  // ── graceful restart (drain → persist → come back) ─────────────────────

  get isDraining(): boolean { return !!this.draining; }

  /** The turn running in this session includes a message from an operator (not only peer / cron / result input). */
  turnFromOperator(channelKey: string): boolean {
    return (this.runtimes.get(channelKey)?.inflightOrigins() ?? []).some((o) => o.kind === "human" && o.trusted);
  }

  /** An operator's own DM session (the chat of a platform operator target). */
  isOperatorChat(channelKey: string): boolean {
    for (const p of this.deps.platforms.values()) {
      for (const t of p.operatorTargets()) if (p.channelKeyForTarget(t) === channelKey) return true;
    }
    return false;
  }

  /** Stop starting turns: from now on new input is persisted and replayed after the restart. Input already
   *  queued behind a running turn is deferred when that turn ends (ChannelRuntime.drain). */
  beginDrain() {
    if (this.draining) return;
    this.draining = { since: Date.now(), acked: new Set() };
    this.deps.log.info("draining for restart");
  }

  /** Restart canceled: turns may start again; everything deferred so far is replayed now. */
  async endDrain(): Promise<number> {
    if (!this.draining) return 0;
    this.draining = undefined;
    return this.replayDeferred();
  }

  /** Turns still in flight. */
  inflightTurns(): InflightTurn[] {
    return [...this.runtimes.values()].filter((r) => r.busy)
      .map((r) => ({ channelKey: r.channelKey, origins: r.inflightOrigins(), detachable: r.canDetach, inputs: r.inflightInputs() }));
  }

  /** Just before stopping: move every runtime's not-yet-sent queue into deferred_input. */
  flushQueuesForRestart(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) {
      for (const q of rt.takeQueue()) { this.storeDeferred(rt.channelKey, q); n++; }
      const dropped = rt.takeDropped();
      if (dropped.length) this.deps.store.pushPending(rt.channelKey, "peer-result", { label: "messages dropped while your queue was full", text: dropped.join("\n") });
    }
    return n;
  }

  private deferInput(channelKey: string, input: QueuedInput): boolean {
    if (!this.draining) return false;
    // The running turn of the asker is waiting for this answer (agent_ask): let it run, the drain waits for it.
    if (input.origin.kind === "peer" && input.origin.mode === "ask" && this.isBusy(input.origin.fromSession)) return false;
    this.storeDeferred(channelKey, input);
    const o = input.origin;
    if (o.kind === "human" && !this.draining.acked.has(channelKey)) {
      this.draining.acked.add(channelKey);
      void this.deps.platforms.get(o.platform)?.send({ ...o.replyTarget, replyToMessageId: o.ref.messageId },
        "⏳ UniQlaw is restarting. Your message is saved and will be answered right after.").catch(() => {});
    }
    return true;
  }

  /** A replayed input deferred again keeps its row (unclaimed); a new one gets a row. */
  private storeDeferred(channelKey: string, input: QueuedInput) {
    if (input.deferredId !== undefined) { this.deps.store.unclaimDeferred(input.deferredId); return; }
    this.deps.store.pushDeferred(channelKey, input);
  }

  /** A turn the stop kills (provider not detachable): queue its human messages again — each with its own origin
   *  and text, steered ones included — so they are answered after the restart instead of silently dropped. Peer,
   *  cron and result inputs are not re-sent (their tasks fail / jobs are not repeated). Returns how many. */
  requeueCutOff(t: InflightTurn): number {
    if (t.detachable) return 0;
    let n = 0;
    for (const q of t.inputs) {
      if (q.origin.kind !== "human" || isPassthroughSlashCommand(q.item.text)) continue;
      const { deferredId: _d, ...rest } = q;
      this.deps.store.pushDeferred(t.channelKey, { ...rest,
        item: { ...q.item, sourceLine: `[Re-sent: a UniQlaw restart cut off your turn on this before it answered] ${q.item.sourceLine}` } } satisfies QueuedInput);
      n++;
    }
    return n;
  }

  /** Replay input deferred during a drain (also after a crash mid-drain). At-least-once: a row is only claimed
   *  here and deleted when the turn that consumes it starts (ChannelRuntime → releaseDeferred), so a crash
   *  before that replays it again on the next start (prepare() unclaims stale claims). Returns how many. */
  async replayDeferred(): Promise<number> {
    const rows = this.deps.store.claimDeferred();
    for (const r of rows) {
      let input: QueuedInput;
      try { input = { ...(JSON.parse(r.payload) as QueuedInput), deferredId: r.id }; }
      catch { this.deps.store.deleteDeferred([r.id]); continue; }
      this.rearmTask(input.origin);
      try {
        const ran = await this.deliverSystemTurn(r.channelKey, "held while UniQlaw restarted", input);
        if (!ran) this.deps.store.deleteDeferred([r.id]); // parked as an unread note: durable there
      } catch (e) { this.deps.log.warn("deferred input not replayed; kept for the next start", { key: r.channelKey, e: String(e) }); }
    }
    if (rows.length) this.deps.log.info("replayed deferred input", { n: rows.length });
    return rows.length;
  }

  /**
   * After a restart nobody waits for the open tasks of the previous process. Each one is either
   *  - re-armed: its request is about to be replayed, or the turn answering it kept running in a reattached session
   *    (inflight-turn) → the answer goes to the asker as usual;
   *  - failed: the turn answering it died with the daemon → the asking session is told (if the task is recent).
   * Two steps: armResumedTasks (in memory only, before restore()) and failUnarmedTasks (writes state.db; only once
   * this start is committed to, see RestartCoordinator.resume).
   */
  armResumedTasks() {
    // Call before restore(): reopening a session consumes its inflight-turn key.
    const origins: Origin[] = [];
    for (const [, v] of this.deps.store.entries("inflight-turn:")) { try { origins.push(...(JSON.parse(v) as Origin[])); } catch {} }
    for (const r of this.deps.store.listDeferred()) { try { origins.push((JSON.parse(r.payload) as QueuedInput).origin); } catch {} }
    for (const o of origins) this.rearmTask(o);
  }

  /** Fail every open task nobody waits for. Nothing is sent here: the failures to report are returned for
   *  reportFailedTasks. `known`: the tasks the restart record listed as open (all are reported); without a
   *  record only recently active ones are. */
  failUnarmedTasks(known?: Set<string>): FailedTask[] {
    const armed = new Set(this.waiters.keys());
    const failed: FailedTask[] = [];
    const now = Date.now();
    for (const t of this.deps.store.openTasks()) {
      if (armed.has(t.taskId)) continue;
      this.deps.store.updateTask(t.taskId, "failed", RESTART_TASK_FAILURE);
      const report = known ? known.has(t.taskId) : now - t.updatedAt <= STALE_TASK_MS;
      if (report && this.deps.store.getSession(t.fromSession)) failed.push({ taskId: t.taskId, from: t.fromSession, to: t.toSession, mode: t.mode });
    }
    return failed;
  }

  /** Tell the operators something directly (their own chats), e.g. a restart that failed with no record to report on. */
  async notifyOperators(text: string) {
    for (const p of this.deps.platforms.values()) for (const t of p.operatorTargets()) await p.send(t, text).catch(() => {});
  }

  /** Tell the askers of tasks the restart killed (failUnarmedTasks), once platforms are up. */
  reportFailedTasks(list: FailedTask[]) {
    for (const t of list) {
      if (t.mode === "ask") this.deliverAsyncResult(t.from, t.to, t.taskId, { hop: 0, rounds: 0, chain: `restart:${t.taskId}` }, { ok: false, text: `${RESTART_TASK_FAILURE}. Ask again if you still need it.` });
      else this.deps.store.pushPending(t.from, "peer-result", { label: `your agent_trigger to ${t.to} (task ${t.taskId}) failed`, text: RESTART_TASK_FAILURE });
    }
  }

  /** Run a system input (restart notice, replayed input) as a turn, unless a human holds the session: a worker
   *  a human drives gets it as an unread note instead (only the human's own messages go through), and a session
   *  handed to a terminal is not reopened. */
  /** Returns false when it was parked as a note instead of queued. */
  async deliverSystemTurn(key: string, label: string, input: QueuedInput): Promise<boolean> {
    const handedOff = this.terminalHold(key)?.live === false;
    const held = this.workerMeta(key) && this.heldBy(key) && input.origin.kind !== "human";
    if (handedOff || held) { this.deps.store.pushPending(key, "peer-result", { label, text: input.item.text }); return false; }
    await this.runtime(key).enqueue(input);
    return true;
  }

  /** Register a waiter for a task that survived a restart (replayed or still running). */
  private rearmTask(o: Origin): boolean {
    if (o.kind !== "peer" || (o.mode !== "ask" && o.mode !== "trigger") || this.waiters.has(o.taskId)) return false;
    const t = this.deps.store.getTask(o.taskId);
    if (!t || (t.state !== "submitted" && t.state !== "working")) return false;
    // The asker's outstanding-task count (bus.maxPending) is in memory: count the re-armed task again.
    const from = o.fromSession;
    this.pendingAsync.set(from, (this.pendingAsync.get(from) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.pendingAsync.get(from) ?? 1) - 1;
      if (n > 0) this.pendingAsync.set(from, n); else this.pendingAsync.delete(from);
    };
    this.waiters.set(o.taskId, this.asyncWaiter(o.mode, from, t.toSession, o.taskId,
      { hop: Math.max(0, o.hop - 1), rounds: o.rounds ?? 0, chain: o.chain ?? `restart:${o.taskId}` }, release));
    return true;
  }

  /** Where the answer of an asynchronous task goes: ask → a result turn for the asker (at the asker's own hop,
   *  rounds and chain, see deliverAsyncResult), trigger → an echo. `release` frees the asker's bus.maxPending slot. */
  private asyncWaiter(mode: "ask" | "trigger", from: string, to: string, taskId: string,
    at: { hop: number; rounds: number; chain: string }, release?: () => void): TaskWaiter {
    if (mode === "ask") return { resolve: (r) => { release?.(); this.deliverAsyncResult(from, to, taskId, at, r); }, merged: () => release?.() };
    return { resolve: (r) => {
      release?.();
      // Only sessions get the echo; CLI/API callers ("cli", "api", …) are not sessions.
      if (this.deps.store.getSession(from)) this.deps.store.pushPending(from, "peer-result", { label: `trigger response from ${to}`, text: r.text });
    } };
  }

  parseTargetString(s: string): Target | undefined {
    const [p] = s.split(":");
    return p ? this.deps.platforms.get(p)?.parseTarget(s) : undefined;
  }

  /** Session (channel key) that owns a target string like "telegram:<chatId>"; undefined if unresolvable. */
  channelKeyForTarget(s: string): string | undefined {
    const t = this.parseTargetString(s);
    return t ? this.deps.platforms.get(t.platform)?.channelKeyForTarget(t) : undefined;
  }

  private targetForChannel(key: string): Target | undefined {
    const [p] = key.split(":");
    return p ? this.deps.platforms.get(p)?.parseTarget(key) : undefined;
  }

  private waitTask(taskId: string) {
    return new Promise<{ ok: boolean; text: string }>((resolve) => this.waiters.set(taskId, { resolve }));
  }

  private completeTask(taskId: string, ok: boolean, text: string, mergedInto?: string) {
    this.deps.store.updateTask(taskId, ok ? "completed" : "failed", text);
    const w = this.waiters.get(taskId);
    this.waiters.delete(taskId);
    if (mergedInto && w?.merged) { w.merged(); return; }
    w?.resolve({ ok, text: text || "(empty reply)" });
  }

  /** `at.hop` is the asker's own hop when it asked (not the callee's): a result is the answer to the asker's chain,
   *  not a step deeper, so a chat can keep working with its worker. `at.rounds` bounds result → ask → result … */
  private deliverAsyncResult(asker: string, answerer: string, taskId: string, at: { hop: number; rounds: number; chain: string }, r: { ok: boolean; text: string }) {
    // CLI / API callers ("cli", "api") are not sessions: the result stays in the task (task_status).
    if (!this.runtimes.has(asker) && !this.deps.store.getSession(asker)) return;
    if (this.workerMeta(asker) && this.heldBy(asker)) {
      // Don't reopen / interrupt a worker a human is driving: it reads the result on its next turn.
      this.deps.store.pushPending(asker, "peer-result", { label: `result of your agent_ask ${taskId} to ${answerer}${r.ok ? "" : " (failed)"}`, text: r.text });
      return;
    }
    void this.runtime(asker).enqueue({
      origin: { kind: "peer", fromSession: answerer, hop: at.hop, rounds: at.rounds, chain: at.chain, mode: "result", taskId },
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

/** Default upload kind from the file extension. */
export function kindFromName(name: string): OutboundFile["kind"] {
  const ext = extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if ([".ogg", ".oga", ".opus"].includes(ext)) return "voice";
  if ([".mp3", ".m4a", ".wav", ".flac", ".aac"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".webm", ".mkv"].includes(ext)) return "video";
  return "file";
}
