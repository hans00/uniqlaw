// Discord PlatformAdapter: Gateway WebSocket + REST. Ported from claudeclaw-v2
// platforms/discord.ts + daemon.ts routeDiscord (UniQlaw: DM → "discord:dm:<userId>", guild channel → "discord:<id>").
import { randomBytes } from "node:crypto";
import type {
  Attachment, ChoiceRequest, InboundMessage, InboundSink, Logger, MsgRef, PlatformAdapter,
  OutboundFile, PlatformCapabilities, PlatformCommand, Target,
} from "@uniqlaw/core";
import { chunkText, downloadTo, extFromName, kindFromMime, sleep } from "./download.ts";

export const DISCORD_MSG_LIMIT = 1900;

const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const FLAG_VOICE_MESSAGE = 1 << 13;
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export interface DiscordChannelOptions { enabled: boolean; requireMention?: boolean; ignoreOtherMentions?: boolean }

export interface DiscordAdapterOptions {
  token: string;
  apiBase: string;
  gatewayUrl: string;
  /** Override for the sticker CDN (tests). */
  cdnBase: string;
  allowedUserIds: string[];
  allowedBotIds: string[];
  operatorUserIds: string[];
  channels: Record<string, DiscordChannelOptions>;
  attachmentsDir: string;
  log: Logger;
}

interface PendingChoice {
  channelId: string;
  messageId: string;
  req: ChoiceRequest;
  content: string;
  resolve: (idx: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly name = "discord";
  readonly capabilities: PlatformCapabilities = {
    edit: true, delete: true, reactions: true, buttons: true, typing: true, maxMessageLength: DISCORD_MSG_LIMIT,
  };

  private readonly log: Logger;
  private sink: InboundSink | null = null;
  private paired = new Set<string>();
  setPairedUsers(userIds: string[]) { this.paired = new Set(userIds); }
  private ws: WebSocket | null = null;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatJitter: ReturnType<typeof setTimeout> | null = null;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private resumeOnConnect = false;
  private reconnectDelay = 1000;
  private botUserId: string | null = null;
  private applicationId: string | null = null;
  private pendingCommands: PlatformCommand[] | null = null;
  private readyResolve: (() => void) | null = null;
  private readonly pending = new Map<string, PendingChoice>();
  /** user id → DM channel id (operator targets; DM session key "discord:dm:<userId>"). */
  private readonly dmByUser = new Map<string, string>();

  constructor(private readonly opts: DiscordAdapterOptions) {
    this.log = opts.log;
    if (opts.allowedUserIds.length === 0 && opts.allowedBotIds.length === 0) {
      this.log.warn("discord: allowedUserIds is empty — every inbound message will be rejected");
    }
  }

  get botUser(): string | null { return this.botUserId; }

  async start(sink: InboundSink): Promise<void> {
    if (this.running) return;
    this.sink = sink;
    this.running = true;
    const ready = new Promise<void>((r) => (this.readyResolve = r));
    this.connect();
    // Don't block daemon startup forever on a flaky gateway; READY usually lands in < 2s.
    await Promise.race([ready, sleep(10_000)]);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.cleanupHeartbeat();
    try { this.ws?.close(1000, "shutdown"); } catch {}
    this.ws = null;
    for (const [token, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(token);
      p.resolve(null);
    }
    this.log.info("discord: stopped");
  }

  // ── gateway ──────────────────────────────────────────────────────────────

  private connect(): void {
    if (!this.running) return;
    const url = this.resumeOnConnect && this.resumeUrl
      ? `${this.resumeUrl}${this.resumeUrl.includes("?") ? "" : "?v=10&encoding=json"}`
      : this.opts.gatewayUrl;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      let p: any;
      try { p = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      this.handleFrame(p).catch((err) => this.log.error("discord: frame handler error", { err: String(err) }));
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.cleanupHeartbeat();
      this.ws = null;
      if (!this.resumeOnConnect) this.lastSeq = null;
      if (!this.running) return;
      if (FATAL_CLOSE.has(ev.code)) {
        this.log.error(`discord: fatal gateway close ${ev.code} (${ev.reason || "no reason"}) — not reconnecting`);
        this.running = false;
        return;
      }
      this.log.warn(`discord: gateway closed (${ev.code}); reconnecting in ${this.reconnectDelay}ms`);
      const d = this.reconnectDelay;
      this.reconnectDelay = Math.min(d * 2, 30_000);
      setTimeout(() => this.connect(), d);
    });
    ws.addEventListener("error", () => { /* close follows */ });
  }

  private async handleFrame(p: { op: number; t?: string; s?: number | null; d?: any }): Promise<void> {
    if (typeof p.s === "number") this.lastSeq = p.s;
    switch (p.op) {
      case 10: { // HELLO
        this.startHeartbeat(p.d?.heartbeat_interval ?? 41_250);
        if (this.resumeOnConnect && this.sessionId && this.lastSeq !== null) {
          this.sendOp(6, { token: this.opts.token, session_id: this.sessionId, seq: this.lastSeq });
          this.resumeOnConnect = false;
        } else this.identify();
        return;
      }
      case 1: this.sendOp(1, this.lastSeq); return; // HEARTBEAT request
      case 11: return; // ACK
      case 7: // RECONNECT
        this.resumeOnConnect = true;
        try { this.ws?.close(4000, "reconnect requested"); } catch {}
        return;
      case 9: // INVALID_SESSION
        if (p.d === true) setTimeout(() => this.sendOp(6, { token: this.opts.token, session_id: this.sessionId, seq: this.lastSeq }), 1500);
        else { this.sessionId = null; this.lastSeq = null; this.resumeOnConnect = false; setTimeout(() => this.identify(), 1500); }
        return;
      case 0:
        this.reconnectDelay = 1000;
        await this.handleDispatch(p.t ?? "", p.d);
    }
  }

  private identify() {
    this.sendOp(2, { token: this.opts.token, intents: INTENTS, properties: { os: process.platform, browser: "uniqlaw", device: "uniqlaw" } });
  }

  private startHeartbeat(intervalMs: number) {
    this.cleanupHeartbeat();
    this.heartbeatJitter = setTimeout(() => {
      if (!this.running) return;
      this.sendOp(1, this.lastSeq);
      this.heartbeatTimer = setInterval(() => this.sendOp(1, this.lastSeq), intervalMs);
    }, Math.random() * intervalMs);
  }

  private cleanupHeartbeat() {
    if (this.heartbeatJitter) clearTimeout(this.heartbeatJitter);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatJitter = null;
    this.heartbeatTimer = null;
  }

  private sendOp(op: number, d: unknown) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ op, d })); } catch (err) { this.log.warn(`discord: send op ${op} failed`, { err: String(err) }); }
  }

  private async handleDispatch(t: string, d: any): Promise<void> {
    if (t === "READY") {
      this.botUserId = d?.user?.id ?? null;
      this.applicationId = d?.application?.id ?? this.botUserId;
      this.sessionId = d?.session_id ?? null;
      this.resumeUrl = d?.resume_gateway_url ?? null;
      this.log.info(`discord: READY as ${d?.user?.username ?? "?"} (${this.botUserId})`);
      if (this.pendingCommands) { const c = this.pendingCommands; this.pendingCommands = null; await this.registerCommands(c); }
      this.readyResolve?.();
      this.readyResolve = null;
      return;
    }
    if (t === "MESSAGE_CREATE") return this.handleMessage(d);
    if (t === "INTERACTION_CREATE") return this.handleInteraction(d);
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private allowedAuthor(author: { id: string; bot?: boolean }): boolean {
    return author.bot ? this.opts.allowedBotIds.includes(author.id) : this.opts.allowedUserIds.includes(author.id) || this.paired.has(author.id);
  }

  /** Exposed for tests; normally driven by the gateway. */
  async handleMessage(m: any): Promise<void> {
    if (!m?.author || (this.botUserId && m.author.id === this.botUserId)) return;
    const author = m.author as { id: string; bot?: boolean; username?: string; global_name?: string };
    if (!this.allowedAuthor(author)) {
      this.log.debug(`discord: rejected message from ${author.id}`);
      if (!author.bot && (m.guild_id ?? null) === null) {
        this.dmByUser.set(author.id, String(m.channel_id));
        this.sink?.unknownSender?.({ platform: "discord", userId: author.id, name: String(author.global_name ?? author.username ?? author.id),
          ...(author.username ? { username: author.username } : {}), replyTarget: { platform: "discord", chatId: String(m.channel_id) } });
      }
      return;
    }

    const guildId: string | null = m.guild_id ?? null;
    const channelId = String(m.channel_id);
    const isDM = guildId === null;
    const mentions: { id: string }[] = Array.isArray(m.mentions) ? m.mentions : [];
    const mentionsBot = !!this.botUserId && mentions.some((u) => u?.id === this.botUserId);
    const repliesToBot = !!this.botUserId && m.referenced_message?.author?.id === this.botUserId;
    if (!isDM) {
      const ch = this.opts.channels[channelId];
      if (!ch?.enabled) return;
    } else {
      this.dmByUser.set(author.id, channelId);
    }

    let text = String(m.content ?? "");
    if (this.botUserId) text = text.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").replace(/\s{2,}/g, " ").trim();
    const attachments = await this.collectAttachments(m, channelId);
    if (!text && !attachments.length) return;

    const inbound: InboundMessage = {
      platform: "discord",
      channelKey: isDM ? `discord:dm:${author.id}` : `discord:${channelId}`,
      replyTarget: { platform: "discord", chatId: channelId, replyToMessageId: String(m.id) },
      ref: { platform: "discord", chatId: channelId, messageId: String(m.id) },
      sender: { id: author.id, name: String(author.global_name ?? author.username ?? author.id),
        ...(author.username ? { username: author.username } : {}), isBot: !!author.bot },
      trusted: this.opts.operatorUserIds.includes(author.id),
      multiparty: !isDM,
      text,
      attachments,
      addressed: isDM || mentionsBot || repliesToBot,
      mentionsOthers: !mentionsBot && mentions.some((u) => u?.id !== this.botUserId),
      ...(isDM ? {} : groupPolicyOf(this.opts.channels[channelId])),
      receivedAt: Date.now(),
    };
    this.sink?.message(inbound);
  }

  private async handleInteraction(i: any): Promise<void> {
    const user = i?.member?.user ?? i?.user;
    if (!user) return;
    if (i.type === 3) return this.handleComponent(i, user); // MESSAGE_COMPONENT
    if (i.type !== 2) return; // APPLICATION_COMMAND
    if (!this.allowedAuthor(user)) {
      await this.respondInteraction(i, { type: 4, data: { content: "You are not allowed to use this bot.", flags: 64 } });
      return;
    }
    const channelId = String(i.channel_id);
    const isDM = !i.guild_id;
    if (!isDM && !this.opts.channels[channelId]?.enabled) {
      await this.respondInteraction(i, { type: 4, data: { content: "This channel is not enabled for the bot.", flags: 64 } });
      return;
    }
    if (isDM) this.dmByUser.set(user.id, channelId);
    const args = (i.data?.options ?? []).map((o: { value: unknown }) => String(o.value)).join(" ").trim();
    const text = `/${i.data?.name ?? ""}${args ? ` ${args}` : ""}`;
    await this.respondInteraction(i, { type: 4, data: { content: `\`${text}\`` } });
    this.sink?.message({
      platform: "discord",
      channelKey: isDM ? `discord:dm:${user.id}` : `discord:${channelId}`,
      replyTarget: { platform: "discord", chatId: channelId },
      ref: { platform: "discord", chatId: channelId, messageId: String(i.id) },
      sender: { id: user.id, name: String(user.global_name ?? user.username ?? user.id), ...(user.username ? { username: user.username } : {}) },
      trusted: this.opts.operatorUserIds.includes(user.id),
      multiparty: !isDM,
      text,
      attachments: [],
      addressed: true,
      receivedAt: Date.now(),
    });
  }

  private async handleComponent(i: any, user: { id: string; username?: string; global_name?: string }): Promise<void> {
    const m = /^c:([a-f0-9]+):(\d+)$/.exec(String(i.data?.custom_id ?? ""));
    const p = m ? this.pending.get(m[1]!) : undefined;
    if (!m || !p) {
      await this.respondInteraction(i, { type: 4, data: { content: m ? "Expired" : "Unknown action", flags: 64 } });
      return;
    }
    if (!p.req.approverIds.includes(String(user.id))) {
      await this.respondInteraction(i, { type: 4, data: { content: "You are not allowed to answer this", flags: 64 } });
      return;
    }
    const idx = Number(m[2]);
    if (idx < 0 || idx >= p.req.options.length) {
      await this.respondInteraction(i, { type: 4, data: { content: "Invalid option", flags: 64 } });
      return;
    }
    this.pending.delete(m[1]!);
    clearTimeout(p.timer);
    const label = p.req.options[idx]!;
    // UPDATE_MESSAGE: replace prompt with outcome, drop the buttons.
    await this.respondInteraction(i, { type: 7, data: { content: clip(`✅ ${label} — ${user.global_name ?? user.username ?? user.id}\n\n${p.content}`), components: [] } });
    p.resolve(idx);
  }

  private async respondInteraction(i: any, body: unknown) {
    const r = await this.rest("POST", `/interactions/${i.id}/${i.token}/callback`, body);
    if (!r.ok) this.log.warn(`discord: interaction callback failed (${r.status})`);
  }

  private async collectAttachments(m: any, channelId: string): Promise<Attachment[]> {
    const out: Attachment[] = [];
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const isVoice = typeof m.flags === "number" && (m.flags & FLAG_VOICE_MESSAGE) !== 0;
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      if (!a?.url) continue;
      let kind = kindFromMime(a.content_type);
      if (isVoice && kind === "audio") kind = "voice";
      const att = await downloadTo({ url: a.url, dir: this.opts.attachmentsDir, platform: "discord", scope: channelId,
        fileName: `${ts}-${m.id}-${kind}${extFromName(a.filename)}`, kind, mime: a.content_type, name: a.filename,
        ...(typeof a.duration_secs === "number" ? { durationSec: a.duration_secs } : {}), log: this.log });
      if (att) out.push(att);
    }
    for (const s of Array.isArray(m.sticker_items) ? m.sticker_items : []) {
      if (!s?.id) continue;
      const att = await downloadTo({ url: `${this.opts.cdnBase}/stickers/${s.id}.webp`, dir: this.opts.attachmentsDir, platform: "discord",
        scope: channelId, fileName: `${ts}-${m.id}-sticker.webp`, kind: "sticker", mime: "image/webp", name: s.name, log: this.log });
      if (att) out.push(att);
    }
    return out;
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async send(target: Target, markdown: string): Promise<MsgRef | undefined> {
    if (!markdown) return undefined;
    const channelId = await this.resolveChannel(target.chatId);
    if (!channelId) return undefined;
    let first: MsgRef | undefined;
    const chunks = chunkText(markdown, DISCORD_MSG_LIMIT);
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { content: chunks[i], allowed_mentions: { parse: ["users"], replied_user: false } };
      if (i === 0 && target.replyToMessageId) body.message_reference = { message_id: target.replyToMessageId, fail_if_not_exists: false };
      const r = await this.rest("POST", `/channels/${channelId}/messages`, body);
      if (!r.ok) { this.log.error(`discord: send failed (${r.status}): ${r.text.slice(0, 200)}`); continue; }
      if (!first && r.json?.id) first = { platform: "discord", chatId: channelId, messageId: String(r.json.id) };
    }
    return first;
  }

  /** One message with the file attached (multipart: payload_json + files[0]). Voice notes go as plain audio files. */
  async sendFile(target: Target, file: OutboundFile): Promise<MsgRef | undefined> {
    const channelId = await this.resolveChannel(target.chatId);
    if (!channelId) return undefined;
    const payload: Record<string, unknown> = { content: file.caption ? clip(file.caption) : "", allowed_mentions: { parse: ["users"], replied_user: false },
      attachments: [{ id: 0, filename: file.name }] };
    if (target.replyToMessageId) payload.message_reference = { message_id: target.replyToMessageId, fail_if_not_exists: false };
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", Bun.file(file.path), file.name);
    try {
      const res = await fetch(`${this.opts.apiBase}/channels/${channelId}/messages`, { method: "POST", headers: { authorization: `Bot ${this.opts.token}` }, body: form });
      const json = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
      if (!res.ok || !json?.id) { this.log.error(`discord: file upload failed (${res.status}): ${json?.message ?? ""}`); return undefined; }
      return { platform: "discord", chatId: channelId, messageId: String(json.id) };
    } catch (err) {
      this.log.error(`discord: file upload failed: ${String(err)}`);
      return undefined;
    }
  }

  async edit(ref: MsgRef, markdown: string): Promise<boolean> {
    const chunks = chunkText(markdown, DISCORD_MSG_LIMIT);
    if (chunks.length !== 1) return false;
    const r = await this.rest("PATCH", `/channels/${ref.chatId}/messages/${ref.messageId}`, { content: chunks[0] });
    if (!r.ok) this.log.warn(`discord: edit failed (${r.status})`);
    return r.ok;
  }

  async delete(ref: MsgRef): Promise<boolean> {
    const r = await this.rest("DELETE", `/channels/${ref.chatId}/messages/${ref.messageId}`);
    return r.ok || r.status === 404;
  }

  async react(ref: MsgRef, emojis: string[]): Promise<void> {
    for (const e of emojis) {
      const name = e.replace(/^:|:$/g, "");
      const r = await this.rest("PUT", `/channels/${ref.chatId}/messages/${ref.messageId}/reactions/${encodeURIComponent(name)}/@me`);
      if (!r.ok) this.log.warn(`discord: reaction ${e} failed (${r.status})`);
    }
  }

  async typing(target: Target): Promise<void> {
    const channelId = await this.resolveChannel(target.chatId);
    if (channelId) await this.rest("POST", `/channels/${channelId}/typing`).catch(() => {});
  }

  async askChoice(target: Target, req: ChoiceRequest): Promise<number | null> {
    const channelId = await this.resolveChannel(target.chatId);
    if (!channelId) return null;
    const token = randomBytes(6).toString("hex");
    const content = clip(req.body ? `**${req.title}**\n\n${req.body}` : `**${req.title}**`);
    const buttons = req.options.slice(0, 25).map((label, i) => ({
      type: 2, style: /^(no|deny|cancel|reject)/i.test(label.trim()) ? 4 : i === 0 ? 3 : 2,
      label: label.slice(0, 80), custom_id: `c:${token}:${i}`,
    }));
    const rows: unknown[] = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
    const r = await this.rest("POST", `/channels/${channelId}/messages`, { content, components: rows, allowed_mentions: { parse: [] } });
    if (!r.ok || !r.json?.id) { this.log.error(`discord: askChoice send failed (${r.status})`); return null; }
    const messageId = String(r.json.id);
    const approverIds = req.approverIds.length ? req.approverIds : this.opts.operatorUserIds;
    return new Promise<number | null>((resolve) => {
      const timer = setTimeout(async () => {
        if (!this.pending.delete(token)) return;
        await this.rest("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: clip(`⏱ Timed out — no answer\n\n${content}`), components: [] }).catch(() => {});
        resolve(null);
      }, req.timeoutMs);
      this.pending.set(token, { channelId, messageId, req: { ...req, approverIds }, content, resolve, timer });
    });
  }

  async setCommands(cmds: PlatformCommand[]): Promise<void> {
    if (!this.applicationId) { this.pendingCommands = cmds; return; }
    await this.registerCommands(cmds);
  }

  private async registerCommands(cmds: PlatformCommand[]) {
    const seen = new Set<string>();
    const body: unknown[] = [];
    for (const c of cmds) {
      const name = c.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      body.push({ name, description: (c.description || "-").slice(0, 100), type: 1,
        options: [{ type: 3, name: "args", description: "arguments", required: false }] });
    }
    const r = await this.rest("PUT", `/applications/${this.applicationId}/commands`, body);
    if (r.ok) this.log.info(`discord: registered ${body.length} slash command(s)`);
    else this.log.warn(`discord: command registration failed (${r.status}): ${r.text.slice(0, 200)}`);
  }

  operatorTargets(): Target[] {
    return this.opts.operatorUserIds.map((id) => ({ platform: "discord", chatId: this.dmByUser.get(id) ?? `dm:${id}` }));
  }

  /** "discord:<channelId>" (or "discord:dm:<userId>"). */
  parseTarget(s: string): Target | undefined {
    const m = /^discord:((?:dm:)?\d+)$/.exec(s.trim());
    return m ? { platform: "discord", chatId: m[1]! } : undefined;
  }

  channelKeyForTarget(t: Target): string {
    // DMs are keyed by user id so "discord:dm:<userId>" round-trips through parseTarget.
    if (t.chatId.startsWith("dm:")) return `discord:${t.chatId}`;
    for (const [user, ch] of this.dmByUser) if (ch === t.chatId) return `discord:dm:${user}`;
    return `discord:${t.chatId}`;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** "dm:<userId>" → DM channel id (opened via REST and cached). */
  private async resolveChannel(chatId: string): Promise<string | undefined> {
    if (!chatId.startsWith("dm:")) return chatId;
    const userId = chatId.slice(3);
    const cached = this.dmByUser.get(userId);
    if (cached) return cached;
    const r = await this.rest("POST", "/users/@me/channels", { recipient_id: userId });
    if (!r.ok || !r.json?.id) { this.log.error(`discord: could not open DM with ${userId} (${r.status})`); return undefined; }
    const id = String(r.json.id);
    this.dmByUser.set(userId, id);
    return id;
  }

  private async rest(method: string, path: string, body?: unknown, retry = true): Promise<{ ok: boolean; status: number; json: any; text: string }> {
    try {
      const res = await fetch(`${this.opts.apiBase}${path}`, {
        method,
        headers: { authorization: `Bot ${this.opts.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text().catch(() => "");
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      if (res.status === 429 && retry) {
        const wait = Math.min(Number(json?.retry_after ?? 1) * 1000, 10_000);
        await sleep(wait);
        return this.rest(method, path, body, false);
      }
      return { ok: res.ok, status: res.status, json, text };
    } catch (err) {
      return { ok: false, status: 0, json: null, text: String(err) };
    }
  }
}

function clip(s: string, max = 2000): string { return s.length > max ? s.slice(0, max - 1) + "…" : s; }

/** v2 per-channel flags → core group policy (only what was set). */
function groupPolicyOf(ch?: { requireMention?: boolean; ignoreOtherMentions?: boolean }): Pick<InboundMessage, "groupPolicy"> {
  const p: NonNullable<InboundMessage["groupPolicy"]> = {};
  if (ch?.requireMention !== undefined) p.mode = ch.requireMention ? "mention" : "always";
  if (ch?.ignoreOtherMentions !== undefined) p.ignoreOtherMentions = ch.ignoreOtherMentions;
  return Object.keys(p).length ? { groupPolicy: p } : {};
}
