// LINE PlatformAdapter: webhook (signature-verified) + Messaging API. Ported from
// claudeclaw-v2 platforms/line.ts + daemon.ts routeLine (UniQlaw: user → "line:<userId>",
// group/room → "line:<id>"). Uses the free reply API while a replyToken is fresh,
// push otherwise. LINE has no edit/delete.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  Attachment, ChoiceRequest, InboundMessage, InboundSink, Logger, MsgRef, PlatformAdapter, PlatformCapabilities, Target,
} from "@uniqlaw/core";
import { chunkText, downloadTo } from "./download.ts";
import { markdownToPlain } from "./format.ts";

export const LINE_MSG_LIMIT = 4500;
/** replyTokens are valid ~1 minute; stay well inside that. */
const REPLY_TOKEN_TTL_MS = 50_000;

export interface LineAdapterOptions {
  channelAccessToken: string;
  channelSecret: string;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
  apiBase: string;
  dataApiBase: string;
  allowedUserIds: string[];
  allowedGroupIds: string[];
  operatorUserIds: string[];
  attachmentsDir: string;
  log: Logger;
}

interface PendingChoice {
  to: string;
  req: ChoiceRequest;
  resolve: (idx: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CONTENT_TYPES: Record<string, { kind: Attachment["kind"]; mime: string; ext: string }> = {
  image: { kind: "image", mime: "image/jpeg", ext: ".jpg" },
  video: { kind: "video", mime: "video/mp4", ext: ".mp4" },
  audio: { kind: "audio", mime: "audio/m4a", ext: ".m4a" },
  file: { kind: "file", mime: "application/octet-stream", ext: "" },
};

export class LineAdapter implements PlatformAdapter {
  readonly name = "line";
  readonly capabilities: PlatformCapabilities = {
    edit: false, delete: false, reactions: false, buttons: true, typing: true, maxMessageLength: LINE_MSG_LIMIT,
  };

  private readonly log: Logger;
  private sink: InboundSink | null = null;
  private paired = new Set<string>();
  setPairedUsers(userIds: string[]) { this.paired = new Set(userIds); }
  private server: ReturnType<typeof Bun.serve> | null = null;
  private botUserId: string | null = null;
  /** inbound messageId → replyToken (single use, short-lived). */
  private readonly replyTokens = new Map<string, { token: string; at: number }>();
  private readonly pending = new Map<string, PendingChoice>();
  private pushSeq = 0;

  constructor(private readonly opts: LineAdapterOptions) {
    this.log = opts.log;
    if (opts.allowedUserIds.length === 0 && opts.allowedGroupIds.length === 0) {
      this.log.warn("line: allowedUserIds and allowedGroupIds are empty — every inbound message will be rejected");
    }
  }

  /** Public webhook URL path on the bound port (useful when webhookPort = 0). */
  get webhookUrl(): string | undefined {
    return this.server ? `http://${this.opts.webhookHost === "0.0.0.0" ? "127.0.0.1" : this.opts.webhookHost}:${this.server.port}${this.opts.webhookPath}` : undefined;
  }

  async start(sink: InboundSink): Promise<void> {
    if (this.server) return;
    this.sink = sink;
    const info = await this.api("GET", "/v2/bot/info");
    if (info.ok) this.botUserId = info.json?.userId ?? null;
    else this.log.warn(`line: could not fetch bot info (${info.status})`);
    this.server = Bun.serve({ hostname: this.opts.webhookHost, port: this.opts.webhookPort, fetch: (req) => this.handle(req) });
    this.log.info(`line: webhook listening on ${this.opts.webhookHost}:${this.server.port}${this.opts.webhookPath}`);
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = null;
    for (const [token, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(token);
      p.resolve(null);
    }
    this.log.info("line: stopped");
  }

  // ── webhook ──────────────────────────────────────────────────────────────

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== this.opts.webhookPath) return new Response("not found", { status: 404 });
    const body = await req.text();
    if (!this.verifySignature(body, req.headers.get("x-line-signature") ?? "")) {
      this.log.warn("line: invalid webhook signature");
      return new Response("invalid signature", { status: 401 });
    }
    // Ack immediately (LINE retries slow webhooks); process async.
    void this.processWebhook(body).catch((err) => this.log.error("line: webhook processing failed", { err: String(err) }));
    return new Response("OK");
  }

  verifySignature(body: string, signature: string): boolean {
    const expected = createHmac("sha256", this.opts.channelSecret).update(body).digest();
    let given: Buffer;
    try { given = Buffer.from(signature, "base64"); } catch { return false; }
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Exposed for tests (bypasses the HTTP layer and signature check). */
  async processWebhook(body: string): Promise<void> {
    let payload: { events?: any[] };
    try { payload = JSON.parse(body); } catch { this.log.warn("line: webhook body is not JSON"); return; }
    for (const ev of payload.events ?? []) {
      try {
        if (ev.type === "message") await this.handleMessage(ev);
        else if (ev.type === "postback") await this.handlePostback(ev);
      } catch (err) { this.log.error("line: event handler error", { err: String(err) }); }
    }
  }

  private sourceOf(ev: any): { type: "user" | "group" | "room"; id: string; userId?: string } | undefined {
    const s = ev.source ?? {};
    const id = s.type === "user" ? s.userId : s.type === "group" ? s.groupId : s.type === "room" ? s.roomId : undefined;
    return id ? { type: s.type, id: String(id), ...(s.userId ? { userId: String(s.userId) } : {}) } : undefined;
  }

  private allowed(src: { type: string; id: string; userId?: string }): boolean {
    const userOk = !!src.userId && (this.opts.allowedUserIds.includes(src.userId) || this.paired.has(src.userId));
    if (src.type === "user") return userOk;
    return userOk || this.opts.allowedGroupIds.includes(src.id);
  }

  private async handleMessage(ev: any): Promise<void> {
    const src = this.sourceOf(ev);
    if (!src) return;
    if (!this.allowed(src)) {
      this.log.debug(`line: rejected message from ${src.userId ?? "?"} in ${src.id}`);
      if (src.type === "user" && src.userId) {
        this.sink?.unknownSender?.({ platform: "line", userId: src.userId, name: await this.displayName(src, src.userId),
          replyTarget: { platform: "line", chatId: src.id } });
      }
      return;
    }
    const m = ev.message ?? {};
    const messageId = String(m.id);
    if (ev.replyToken) this.replyTokens.set(messageId, { token: String(ev.replyToken), at: Date.now() });
    this.pruneTokens();

    const isDM = src.type === "user";
    const mentionees: { isSelf?: boolean; userId?: string }[] = m.mention?.mentionees ?? [];
    const mentioned = mentionees.some((x) => x.isSelf || (this.botUserId && x.userId === this.botUserId));
    let text = "";
    const attachments: Attachment[] = [];
    if (m.type === "text") text = String(m.text ?? "");
    else if (m.type === "sticker") text = `[sticker pkg=${m.packageId} id=${m.stickerId}${m.keywords?.length ? ` (${m.keywords.slice(0, 5).join(", ")})` : ""}]`;
    else if (m.type === "location") text = `[location ${m.title ?? ""} ${m.address ?? ""} (${m.latitude},${m.longitude})]`.replace(/\s+/g, " ");
    else if (CONTENT_TYPES[m.type]) {
      const t = CONTENT_TYPES[m.type]!;
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const att = await downloadTo({ url: `${this.opts.dataApiBase}/v2/bot/message/${messageId}/content`, headers: this.authHeader(),
        dir: this.opts.attachmentsDir, platform: "line", scope: src.id, fileName: `${ts}-${messageId}-${t.kind}${t.ext}`, kind: t.kind,
        mime: t.mime, ...(m.fileName ? { name: String(m.fileName) } : {}), ...(typeof m.duration === "number" ? { durationSec: Math.round(m.duration / 1000) } : {}), log: this.log });
      if (att) attachments.push(att);
    }
    if (!text && !attachments.length) return;

    const fromId = src.userId ?? src.id;
    const inbound: InboundMessage = {
      platform: "line",
      channelKey: `line:${src.id}`,
      replyTarget: { platform: "line", chatId: src.id, replyToMessageId: messageId },
      ref: { platform: "line", chatId: src.id, messageId },
      sender: { id: fromId, name: await this.displayName(src, fromId) },
      trusted: this.opts.operatorUserIds.includes(fromId),
      multiparty: !isDM,
      text,
      attachments,
      addressed: isDM || mentioned,
      ...(!isDM && !mentioned && mentionees.length ? { mentionsOthers: true } : {}),
      receivedAt: Date.now(),
    };
    this.sink?.message(inbound);
  }

  private async displayName(src: { type: string; id: string }, userId: string): Promise<string> {
    const path = src.type === "group" ? `/v2/bot/group/${src.id}/member/${userId}`
      : src.type === "room" ? `/v2/bot/room/${src.id}/member/${userId}` : `/v2/bot/profile/${userId}`;
    const r = await this.api("GET", path);
    return r.ok && r.json?.displayName ? String(r.json.displayName) : userId;
  }

  private async handlePostback(ev: any): Promise<void> {
    const src = this.sourceOf(ev);
    const m = /^c:([a-f0-9]+):(\d+)$/.exec(String(ev.postback?.data ?? ""));
    if (!m) return;
    const p = this.pending.get(m[1]!);
    const replyToken = ev.replyToken ? String(ev.replyToken) : undefined;
    if (!p) { if (replyToken) await this.replyText(replyToken, "Expired"); return; }
    const userId = src?.userId ?? "";
    if (!p.req.approverIds.includes(userId)) {
      if (replyToken) await this.replyText(replyToken, "You are not allowed to answer this");
      return;
    }
    const idx = Number(m[2]);
    if (idx < 0 || idx >= p.req.options.length) return;
    this.pending.delete(m[1]!);
    clearTimeout(p.timer);
    const name = src ? await this.displayName(src, userId) : userId;
    const outcome = `✅ ${p.req.options[idx]} — ${name}`;
    if (replyToken) await this.replyText(replyToken, outcome); else await this.pushMessages(p.to, [{ type: "text", text: outcome }]);
    p.resolve(idx);
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async send(target: Target, markdown: string): Promise<MsgRef | undefined> {
    if (!markdown) return undefined;
    const msgs = chunkText(markdownToPlain(markdown), LINE_MSG_LIMIT).map((text) => ({ type: "text", text }));
    if (!msgs.length) return undefined;
    const id = await this.deliver(target, msgs);
    return id ? { platform: "line", chatId: target.chatId, messageId: id } : undefined;
  }

  /** Reply (free) while the inbound replyToken is fresh; push for the rest/otherwise. */
  private async deliver(target: Target, messages: object[]): Promise<string | undefined> {
    const tok = target.replyToMessageId ? this.replyTokens.get(target.replyToMessageId) : undefined;
    if (tok && Date.now() - tok.at < REPLY_TOKEN_TTL_MS) {
      this.replyTokens.delete(target.replyToMessageId!); // single use
      const first = messages.slice(0, 5);
      const r = await this.api("POST", "/v2/bot/message/reply", { replyToken: tok.token, messages: first });
      if (r.ok) {
        const id = r.json?.sentMessages?.[0]?.id ? String(r.json.sentMessages[0].id) : `reply-${++this.pushSeq}`;
        if (messages.length > 5) await this.pushMessages(target.chatId, messages.slice(5));
        return id;
      }
      this.log.warn(`line: reply failed (${r.status}); falling back to push`);
    }
    return this.pushMessages(target.chatId, messages);
  }

  private async pushMessages(to: string, messages: object[]): Promise<string | undefined> {
    let first: string | undefined;
    for (let i = 0; i < messages.length; i += 5) {
      const r = await this.api("POST", "/v2/bot/message/push", { to, messages: messages.slice(i, i + 5) });
      if (!r.ok) { this.log.error(`line: push failed (${r.status}): ${r.text.slice(0, 200)}`); return first; }
      first ??= r.json?.sentMessages?.[0]?.id ? String(r.json.sentMessages[0].id) : `push-${++this.pushSeq}`;
    }
    return first;
  }

  private async replyText(replyToken: string, text: string) {
    await this.api("POST", "/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] });
  }

  // No react(): the LINE Messaging API has no endpoint for bots to react to messages (absent from the
  // official OpenAPI spec github.com/line/line-openapi and @line/bot-sdk). v2's "sendReaction" call
  // (POST /v2/bot/message/{id}/reaction) targeted an undocumented endpoint.

  async typing(target: Target): Promise<void> {
    if (!target.chatId.startsWith("U")) return; // loading animation only exists in 1:1 chats
    await this.api("POST", "/v2/bot/chat/loading/start", { chatId: target.chatId, loadingSeconds: 20 }).catch(() => {});
  }

  async askChoice(target: Target, req: ChoiceRequest): Promise<number | null> {
    const token = randomBytes(6).toString("hex");
    const text = clip(markdownToPlain(req.body ? `${req.title}\n\n${req.body}` : req.title), LINE_MSG_LIMIT);
    const items = req.options.slice(0, 13).map((label, i) => ({
      type: "action", action: { type: "postback", label: label.slice(0, 20), data: `c:${token}:${i}`, displayText: label.slice(0, 300) },
    }));
    const id = await this.deliver(target, [{ type: "text", text, quickReply: { items } }]);
    if (!id) return null;
    const approverIds = req.approverIds.length ? req.approverIds : this.opts.operatorUserIds;
    return new Promise<number | null>((resolve) => {
      const timer = setTimeout(async () => {
        if (!this.pending.delete(token)) return;
        await this.pushMessages(target.chatId, [{ type: "text", text: `⏱ Timed out — no answer: ${clip(req.title, 200)}` }]).catch(() => {});
        resolve(null);
      }, req.timeoutMs);
      this.pending.set(token, { to: target.chatId, req: { ...req, approverIds }, resolve, timer });
    });
  }

  operatorTargets(): Target[] {
    return this.opts.operatorUserIds.map((id) => ({ platform: "line", chatId: id }));
  }

  parseTarget(s: string): Target | undefined {
    const m = /^line:([UCR][0-9a-f]{32}|[A-Za-z0-9_-]+)$/.exec(s.trim());
    return m ? { platform: "line", chatId: m[1]! } : undefined;
  }

  /** Every source is its own session: users (U…), groups (C…), rooms (R…).*/
  channelKeyForTarget(t: Target): string {
    return `line:${t.chatId}`;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pruneTokens() {
    const now = Date.now();
    for (const [k, v] of this.replyTokens) if (now - v.at > REPLY_TOKEN_TTL_MS) this.replyTokens.delete(k);
  }

  private authHeader() { return { authorization: `Bearer ${this.opts.channelAccessToken}` }; }

  private async api(method: "GET" | "POST", path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any; text: string }> {
    try {
      const res = await fetch(`${this.opts.apiBase}${path}`, {
        method, headers: { ...this.authHeader(), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text().catch(() => "");
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { ok: res.ok, status: res.status, json, text };
    } catch (err) {
      return { ok: false, status: 0, json: null, text: String(err) };
    }
  }
}

function clip(s: string, max: number): string { return s.length > max ? s.slice(0, max - 1) + "…" : s; }
