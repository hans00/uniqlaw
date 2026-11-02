// Slack PlatformAdapter: Socket Mode (WebSocket) + Web API. Ported from claudeclaw-v2
// platforms/slack.ts + daemon.ts routeSlack (IM → "global", channel → "slack:<ch>",
// thread-per-message → "slack:<ch>:<anchorTs>").
import { randomBytes } from "node:crypto";
import type {
  Attachment, ChoiceRequest, InboundMessage, InboundSink, Logger, MsgRef, PlatformAdapter, PlatformCapabilities, Target,
} from "@uniqlaw/core";
import { chunkText, downloadTo, extFromName, kindFromMime, sleep } from "./download.ts";
import { markdownToMrkdwn, slackReactionName } from "./format.ts";

export const GLOBAL_KEY = "global";
export const SLACK_MSG_LIMIT = 3500;

export type SlackChannelMode = "channel" | "thread-per-message";

export interface SlackAdapterOptions {
  appToken: string;
  botToken: string;
  webApiBase: string;
  allowedUserIds: string[];
  allowedBotIds: string[];
  operatorUserIds: string[];
  defaultMode: SlackChannelMode;
  channelModes: Record<string, SlackChannelMode | undefined>;
  attachmentsDir: string;
  log: Logger;
}

interface PendingChoice {
  channel: string;
  ts: string;
  req: ChoiceRequest;
  text: string;
  resolve: (idx: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SlackAdapter implements PlatformAdapter {
  readonly name = "slack";
  readonly capabilities: PlatformCapabilities = {
    edit: true, delete: true, reactions: true, buttons: true, typing: false, maxMessageLength: SLACK_MSG_LIMIT,
  };

  private readonly log: Logger;
  private sink: InboundSink | null = null;
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectDelay = 1000;
  private botUserId: string | null = null;
  private botId: string | null = null;
  private readonly pending = new Map<string, PendingChoice>();
  private readonly names = new Map<string, { name: string; username?: string }>();
  private readonly dmByUser = new Map<string, string>();
  private connectedResolve: (() => void) | null = null;

  constructor(private readonly opts: SlackAdapterOptions) {
    this.log = opts.log;
    if (opts.allowedUserIds.length === 0 && opts.allowedBotIds.length === 0) {
      this.log.warn("slack: allowedUserIds is empty — every inbound message will be rejected");
    }
  }

  get botUser(): string | null { return this.botUserId; }

  async start(sink: InboundSink): Promise<void> {
    if (this.running) return;
    this.sink = sink;
    const me = await this.web("auth.test");
    if (!me?.ok) throw new Error(`slack auth.test failed: ${me?.error ?? "no response"}`);
    this.botUserId = me.user_id ?? null;
    this.botId = me.bot_id ?? null;
    this.running = true;
    const connected = new Promise<void>((r) => (this.connectedResolve = r));
    void this.connect();
    await Promise.race([connected, sleep(10_000)]);
    this.log.info(`slack: socket mode started as ${me.user ?? "?"} (${this.botUserId})`);
  }

  async stop(): Promise<void> {
    this.running = false;
    try { this.ws?.close(1000, "shutdown"); } catch {}
    this.ws = null;
    for (const [token, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(token);
      p.resolve(null);
    }
    this.log.info("slack: stopped");
  }

  // ── socket mode ──────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (!this.running) return;
    const res = await this.appLevel("apps.connections.open");
    if (!res?.ok || !res.url) {
      this.log.error(`slack: apps.connections.open failed: ${res?.error ?? "no response"}`);
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(res.url as string);
    this.ws = ws;
    ws.addEventListener("open", () => { this.reconnectDelay = 1000; });
    ws.addEventListener("message", (ev) => {
      let f: any;
      try { f = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      this.handleFrame(f, ws).catch((err) => this.log.error("slack: frame handler error", { err: String(err) }));
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.running) this.scheduleReconnect();
    });
    ws.addEventListener("error", () => { /* close follows */ });
  }

  private scheduleReconnect() {
    if (!this.running) return;
    const d = this.reconnectDelay;
    this.reconnectDelay = Math.min(d * 2, 30_000);
    setTimeout(() => void this.connect(), d);
  }

  private async handleFrame(f: any, ws: WebSocket): Promise<void> {
    if (f?.type === "hello") { this.connectedResolve?.(); this.connectedResolve = null; return; }
    if (f?.type === "disconnect") { try { ws.close(4000, "disconnect"); } catch {} return; }
    if (f?.envelope_id && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ envelope_id: f.envelope_id })); } catch {} // ACK first so Slack doesn't redeliver
    }
    if (f?.type === "events_api" && f.payload?.event?.type === "message") return this.handleMessage(f.payload.event);
    if (f?.type === "interactive" && f.payload?.type === "block_actions") return this.handleBlockAction(f.payload);
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private modeFor(channel: string): SlackChannelMode {
    return this.opts.channelModes[channel] ?? this.opts.defaultMode;
  }

  /** Exposed for tests; normally driven by Socket Mode. */
  async handleMessage(e: any): Promise<void> {
    if (e.subtype && e.subtype !== "bot_message" && e.subtype !== "file_share" && e.subtype !== "thread_broadcast") return;
    const isBot = !!e.bot_id && !e.user;
    const senderId: string | undefined = e.user ?? e.bot_id;
    if (!senderId) return;
    if (senderId === this.botUserId || (e.bot_id && e.bot_id === this.botId)) return;
    if (isBot ? !this.opts.allowedBotIds.includes(senderId) : !this.opts.allowedUserIds.includes(senderId)) {
      this.log.debug(`slack: rejected message from ${senderId}`);
      return;
    }
    const channel = String(e.channel);
    const isDM = e.channel_type === "im";
    let text = String(e.text ?? "");
    const mentioned = !!this.botUserId && text.includes(`<@${this.botUserId}>`);
    if (this.botUserId) text = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").replace(/\s{2,}/g, " ").trim();
    const attachments = await this.collectAttachments(e, channel);
    if (!text && !attachments.length) return;

    let channelKey = GLOBAL_KEY;
    let threadId: string | undefined = e.thread_ts;
    if (!isDM) {
      if (this.modeFor(channel) === "thread-per-message") {
        const anchor = String(e.thread_ts ?? e.ts);
        channelKey = `slack:${channel}:${anchor}`;
        threadId = anchor; // keep the whole conversation inside the thread
      } else channelKey = `slack:${channel}`;
    } else this.dmByUser.set(senderId, channel);

    const who: { name: string; username?: string } = isBot ? { name: String(e.username ?? senderId) } : await this.userName(senderId);
    const inbound: InboundMessage = {
      platform: "slack",
      channelKey,
      replyTarget: { platform: "slack", chatId: channel, replyToMessageId: String(e.ts), ...(threadId ? { threadId } : {}) },
      ref: { platform: "slack", chatId: channel, messageId: String(e.ts), ...(threadId ? { threadId } : {}) },
      sender: { id: senderId, name: who.name, ...(who.username ? { username: who.username } : {}), isBot },
      trusted: this.opts.operatorUserIds.includes(senderId),
      multiparty: !isDM,
      text,
      attachments,
      addressed: isDM || mentioned,
      receivedAt: Date.now(),
    };
    this.sink?.message(inbound);
  }

  private async userName(id: string): Promise<{ name: string; username?: string }> {
    const cached = this.names.get(id);
    if (cached) return cached;
    const r = await this.web("users.info", { user: id });
    const u = r?.ok ? r.user : undefined;
    const v = { name: String(u?.profile?.display_name || u?.real_name || u?.name || id), ...(u?.name ? { username: String(u.name) } : {}) };
    this.names.set(id, v);
    return v;
  }

  private async handleBlockAction(p: any): Promise<void> {
    const action = p.actions?.[0];
    const m = /^c:([a-f0-9]+):(\d+)$/.exec(String(action?.action_id ?? ""));
    const pend = m ? this.pending.get(m[1]!) : undefined;
    const userId = String(p.user?.id ?? "");
    const channel = String(p.channel?.id ?? pend?.channel ?? "");
    if (!m || !pend) {
      if (channel && userId) await this.web("chat.postEphemeral", { channel, user: userId, text: m ? "Expired" : "Unknown action" });
      return;
    }
    if (!pend.req.approverIds.includes(userId)) {
      await this.web("chat.postEphemeral", { channel: pend.channel, user: userId, text: "You are not allowed to answer this" });
      return;
    }
    const idx = Number(m[2]);
    if (idx < 0 || idx >= pend.req.options.length) return;
    this.pending.delete(m[1]!);
    clearTimeout(pend.timer);
    const label = pend.req.options[idx]!;
    const who = (await this.userName(userId)).name;
    await this.finishChoice(pend, `✅ ${label} — ${who}`);
    pend.resolve(idx);
  }

  private async finishChoice(p: PendingChoice, outcome: string) {
    const r = await this.web("chat.update", { channel: p.channel, ts: p.ts, text: `${outcome}\n\n${p.text}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: clip(`*${outcome}*\n\n${p.text}`, 3000) } }] });
    if (!r?.ok) this.log.warn(`slack: could not update choice message: ${r?.error ?? "?"}`);
  }

  private async collectAttachments(e: any, channel: string): Promise<Attachment[]> {
    const out: Attachment[] = [];
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    for (const f of Array.isArray(e.files) ? e.files : []) {
      const url = f?.url_private_download ?? f?.url_private;
      if (!url) continue;
      let kind = kindFromMime(f.mimetype);
      if (kind === "audio" && (f.subtype === "slack_audio" || f.mode === "transcription")) kind = "voice";
      const att = await downloadTo({ url, headers: { authorization: `Bearer ${this.opts.botToken}` }, dir: this.opts.attachmentsDir,
        platform: "slack", scope: channel, fileName: `${ts}-${e.ts}-${kind}${extFromName(f.name) || (f.mimetype ? `.${String(f.mimetype).split("/").pop()}` : "")}`,
        kind, mime: f.mimetype, name: f.name, ...(typeof f.duration_ms === "number" ? { durationSec: Math.round(f.duration_ms / 1000) } : {}), log: this.log });
      if (att) out.push(att);
    }
    return out;
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async send(target: Target, markdown: string): Promise<MsgRef | undefined> {
    if (!markdown) return undefined;
    const channel = await this.resolveChannel(target.chatId);
    if (!channel) return undefined;
    let first: MsgRef | undefined;
    for (const chunk of chunkText(markdownToMrkdwn(markdown), SLACK_MSG_LIMIT)) {
      const r = await this.web("chat.postMessage", { channel, text: chunk, ...(target.threadId ? { thread_ts: target.threadId } : {}), unfurl_links: false });
      if (!r?.ok) { this.log.error(`slack: chat.postMessage failed: ${r?.error ?? "?"}`); continue; }
      if (!first && r.ts) first = { platform: "slack", chatId: String(r.channel ?? channel), messageId: String(r.ts), ...(target.threadId ? { threadId: target.threadId } : {}) };
    }
    return first;
  }

  async edit(ref: MsgRef, markdown: string): Promise<boolean> {
    const chunks = chunkText(markdownToMrkdwn(markdown), SLACK_MSG_LIMIT);
    if (chunks.length !== 1) return false;
    const r = await this.web("chat.update", { channel: ref.chatId, ts: ref.messageId, text: chunks[0] });
    if (!r?.ok) this.log.warn(`slack: chat.update failed: ${r?.error ?? "?"}`);
    return !!r?.ok;
  }

  async delete(ref: MsgRef): Promise<boolean> {
    const r = await this.web("chat.delete", { channel: ref.chatId, ts: ref.messageId });
    return !!r?.ok || r?.error === "message_not_found";
  }

  async react(ref: MsgRef, emojis: string[]): Promise<void> {
    for (const e of emojis) {
      const name = slackReactionName(e);
      if (!name) { this.log.warn(`slack: no shortcode for reaction ${e}; skipped`); continue; }
      const r = await this.web("reactions.add", { channel: ref.chatId, timestamp: ref.messageId, name });
      if (!r?.ok && r?.error !== "already_reacted") this.log.warn(`slack: reactions.add ${name} failed: ${r?.error ?? "?"}`);
    }
  }

  async askChoice(target: Target, req: ChoiceRequest): Promise<number | null> {
    const channel = await this.resolveChannel(target.chatId);
    if (!channel) return null;
    const token = randomBytes(6).toString("hex");
    const text = markdownToMrkdwn(req.body ? `**${req.title}**\n\n${req.body}` : `**${req.title}**`);
    const buttons = req.options.slice(0, 25).map((label, i) => ({
      type: "button", action_id: `c:${token}:${i}`, value: String(i), text: { type: "plain_text", text: label.slice(0, 75) },
      ...(/^(no|deny|cancel|reject)/i.test(label.trim()) ? { style: "danger" } : i === 0 ? { style: "primary" } : {}),
    }));
    const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: clip(text, 3000) } }];
    for (let i = 0; i < buttons.length; i += 5) blocks.push({ type: "actions", elements: buttons.slice(i, i + 5) });
    const r = await this.web("chat.postMessage", { channel, text: clip(text, 3000), blocks, ...(target.threadId ? { thread_ts: target.threadId } : {}) });
    if (!r?.ok || !r.ts) { this.log.error(`slack: askChoice post failed: ${r?.error ?? "?"}`); return null; }
    const approverIds = req.approverIds.length ? req.approverIds : this.opts.operatorUserIds;
    const pend: Omit<PendingChoice, "resolve" | "timer"> = { channel: String(r.channel ?? channel), ts: String(r.ts), req: { ...req, approverIds }, text };
    return new Promise<number | null>((resolve) => {
      const timer = setTimeout(async () => {
        if (!this.pending.delete(token)) return;
        await this.finishChoice({ ...pend, resolve, timer }, "⏱ Timed out — no answer").catch(() => {});
        resolve(null);
      }, req.timeoutMs);
      this.pending.set(token, { ...pend, resolve, timer });
    });
  }

  operatorTargets(): Target[] {
    return this.opts.operatorUserIds.map((id) => ({ platform: "slack", chatId: this.dmByUser.get(id) ?? `dm:${id}` }));
  }

  /** "slack:<channel>", "slack:<channel>:<threadTs>", "slack:dm:<userId>". */
  parseTarget(s: string): Target | undefined {
    const dm = /^slack:dm:([A-Z0-9]+)$/.exec(s.trim());
    if (dm) return { platform: "slack", chatId: `dm:${dm[1]}` };
    const m = /^slack:([A-Z0-9]+)(?::(\d+\.\d+))?$/.exec(s.trim());
    return m ? { platform: "slack", chatId: m[1]!, ...(m[2] ? { threadId: m[2] } : {}) } : undefined;
  }

  channelKeyForTarget(t: Target): string {
    if (t.chatId.startsWith("dm:") || t.chatId.startsWith("D")) return GLOBAL_KEY;
    if (t.threadId && this.modeFor(t.chatId) === "thread-per-message") return `slack:${t.chatId}:${t.threadId}`;
    return `slack:${t.chatId}`;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async resolveChannel(chatId: string): Promise<string | undefined> {
    if (!chatId.startsWith("dm:")) return chatId;
    const user = chatId.slice(3);
    const cached = this.dmByUser.get(user);
    if (cached) return cached;
    const r = await this.web("conversations.open", { users: user });
    const id = r?.ok ? r.channel?.id : undefined;
    if (!id) { this.log.error(`slack: conversations.open failed for ${user}: ${r?.error ?? "?"}`); return undefined; }
    this.dmByUser.set(user, String(id));
    return String(id);
  }

  private async web(method: string, body?: Record<string, unknown>): Promise<any> {
    return this.call(method, this.opts.botToken, body ? JSON.stringify(body) : undefined, "application/json; charset=utf-8");
  }

  private async appLevel(method: string): Promise<any> {
    return this.call(method, this.opts.appToken, undefined, "application/x-www-form-urlencoded");
  }

  private async call(method: string, token: string, body: string | undefined, type: string, retry = true): Promise<any> {
    try {
      const res = await fetch(`${this.opts.webApiBase}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type }, body });
      if (res.status === 429 && retry) {
        await sleep(Math.min(Number(res.headers.get("retry-after") ?? 1) * 1000, 10_000));
        return this.call(method, token, body, type, false);
      }
      return await res.json().catch(() => null);
    } catch (err) {
      this.log.warn(`slack: ${method} request failed`, { err: String(err) });
      return null;
    }
  }
}

function clip(s: string, max: number): string { return s.length > max ? s.slice(0, max - 1) + "…" : s; }
