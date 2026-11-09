// Telegram PlatformAdapter. Ported from claudeclaw-v2 platforms/telegram.ts and
// the telegram-specific routing in daemon.ts (UniQlaw: every chat is its own session, DM → "telegram:<userId>", group → "telegram:<id>").
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  Attachment, ChoiceRequest, InboundMessage, InboundSink, Logger, MsgRef, PlatformAdapter,
  PlatformCapabilities, PlatformCommand, Target,
} from "@uniqlaw/core";
import { TelegramApi, type TgCallbackQuery, type TgFile, type TgMessage, type TgUpdate, type TgUser } from "./api.ts";
import {
  chunkHtml, chunkText, escapeHtml, htmlToPlain, markdownToTelegramHtml, normalizeCommandName, normalizeEmoji,
  TG_HTML_LIMIT, TG_MSG_LIMIT, TG_REACTION_EMOJIS,
} from "./format.ts";

export interface TelegramAdapterOptions {
  token: string;
  apiBase: string;
  allowedUserIds: string[];
  /** When non-empty, group messages are only accepted from these chats. */
  allowedGroupIds: string[];
  operatorUserIds: string[];
  pollSeconds: number;
  /** Absolute dir for downloaded attachments (`<stateDir>/attachments`). */
  attachmentsDir: string;
  log: Logger;
}

interface PendingChoice {
  chatId: string;
  messageId: number;
  req: ChoiceRequest;
  html: string;
  resolve: (idx: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"];

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram";
  readonly capabilities: PlatformCapabilities = {
    edit: true, delete: true, reactions: true, buttons: true, typing: true, maxMessageLength: TG_MSG_LIMIT,
  };

  private readonly api: TelegramApi;
  private readonly log: Logger;
  private sink: InboundSink | null = null;
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private bot: TgUser | null = null;
  private readonly pending = new Map<string, PendingChoice>();

  constructor(private readonly opts: TelegramAdapterOptions) {
    this.api = new TelegramApi(opts.apiBase, opts.token);
    this.log = opts.log;
    if (opts.allowedUserIds.length === 0) {
      this.log.warn("telegram: allowedUserIds is empty — every inbound message will be rejected");
    }
  }

  /** Bot identity from getMe (available after start()). */
  get botUser(): TgUser | null { return this.bot; }

  async start(sink: InboundSink): Promise<void> {
    if (this.running) return;
    this.sink = sink;
    const me = await this.api.call<TgUser>("getMe");
    if (!me.ok || !me.result) throw new Error(`telegram getMe failed (${me.status}): ${me.description ?? "no response"}`);
    this.bot = me.result;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
    this.log.info(`telegram: long-poll started as @${this.bot.username ?? this.bot.id}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
    // Telegram only forgets updates once a later getUpdates passes a higher offset. Confirm what we handled,
    // or a restarted daemon receives the last message(s) again. Anything returned here stays unconfirmed.
    if (this.offset > 0) await this.api.call("getUpdates", { offset: this.offset, timeout: 0, limit: 1 }).catch(() => {});
    for (const [token, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(token);
      p.resolve(null);
    }
    this.log.info("telegram: stopped");
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async send(target: Target, markdown: string): Promise<MsgRef | undefined> {
    if (!markdown) return undefined;
    const chunks = chunkHtml(markdownToTelegramHtml(markdown), TG_HTML_LIMIT);
    let first: MsgRef | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const base = this.targetFields(target, i === 0);
      let r = await this.api.call<{ message_id: number }>("sendMessage", {
        ...base, text: chunks[i], parse_mode: "HTML", link_preview_options: { is_disabled: true },
      });
      if (!r.ok) {
        // HTML payload probably broke the parser — retry the same chunk as plain text.
        this.log.warn(`telegram: sendMessage HTML failed (${r.status}): ${r.description ?? ""}; retrying as plain text`);
        for (const plain of chunkText(htmlToPlain(chunks[i]!), TG_MSG_LIMIT)) {
          r = await this.api.call<{ message_id: number }>("sendMessage", {
            ...base, text: plain, link_preview_options: { is_disabled: true },
          });
          if (!r.ok) this.log.error(`telegram: plain fallback failed (${r.status}): ${r.description ?? ""}`);
          else if (!first && r.result) first = this.ref(target, r.result.message_id);
        }
        continue;
      }
      if (!first && r.result) first = this.ref(target, r.result.message_id);
    }
    return first;
  }

  async edit(ref: MsgRef, markdown: string): Promise<boolean> {
    const id = Number(ref.messageId);
    if (!Number.isFinite(id)) return false;
    const chunks = chunkHtml(markdownToTelegramHtml(markdown), TG_HTML_LIMIT);
    if (chunks.length !== 1) return false; // multi-chunk edits unsupported → caller sends instead
    const r = await this.api.call("editMessageText", {
      chat_id: ref.chatId, message_id: id, text: chunks[0], parse_mode: "HTML", link_preview_options: { is_disabled: true },
    });
    if (r.ok || r.description?.includes("message is not modified")) return true;
    this.log.warn(`telegram: editMessageText failed (${r.status}): ${r.description ?? ""}`);
    return false;
  }

  async delete(ref: MsgRef): Promise<boolean> {
    const id = Number(ref.messageId);
    if (!Number.isFinite(id)) return false;
    const r = await this.api.call("deleteMessage", { chat_id: ref.chatId, message_id: id });
    if (r.ok || r.description?.includes("message to delete not found")) return true;
    this.log.warn(`telegram: deleteMessage failed (${r.status}): ${r.description ?? ""}`);
    return false;
  }

  /** Replaces the bot's reactions (setMessageReaction is replace-not-append). */
  async react(ref: MsgRef, emojis: string[]): Promise<void> {
    const supported = emojis.map(normalizeEmoji).filter((e) => TG_REACTION_EMOJIS.has(e));
    const dropped = emojis.filter((e) => !TG_REACTION_EMOJIS.has(normalizeEmoji(e)));
    if (dropped.length) this.log.warn(`telegram: dropping unsupported reactions: ${dropped.join(" ")}`);
    if (!supported.length && emojis.length) return;
    const r = await this.api.call("setMessageReaction", {
      chat_id: ref.chatId, message_id: Number(ref.messageId),
      reaction: supported.map((emoji) => ({ type: "emoji", emoji })), is_big: false,
    });
    if (!r.ok) this.log.warn(`telegram: setMessageReaction failed (${r.status}): ${r.description ?? ""}`);
  }

  async typing(target: Target): Promise<void> {
    try {
      await this.api.call("sendChatAction", {
        chat_id: target.chatId, action: "typing",
        ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      });
    } catch { /* cosmetic */ }
  }

  async askChoice(target: Target, req: ChoiceRequest): Promise<number | null> {
    const token = randomBytes(6).toString("hex");
    const html = req.body
      ? `<b>${escapeHtml(req.title)}</b>\n\n${markdownToTelegramHtml(req.body)}`
      : `<b>${escapeHtml(req.title)}</b>`;
    const text = chunkHtml(html, TG_HTML_LIMIT)[0] ?? escapeHtml(req.title);
    const keyboard = req.options.map((label, i) => [{ text: label.slice(0, 64), callback_data: `c:${token}:${i}` }]);
    const r = await this.api.call<{ message_id: number }>("sendMessage", {
      ...this.targetFields(target, true), text, parse_mode: "HTML",
      link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard },
    });
    if (!r.ok || !r.result) {
      this.log.error(`telegram: askChoice send failed (${r.status}): ${r.description ?? ""}`);
      return null;
    }
    const messageId = r.result.message_id;
    return new Promise<number | null>((resolve) => {
      const timer = setTimeout(async () => {
        if (!this.pending.delete(token)) return;
        await this.finishChoice(target.chatId, messageId, text, "⏱ Timed out — no answer").catch(() => {});
        resolve(null);
      }, req.timeoutMs);
      // Empty approverIds = this platform's configured operators (core doesn't know platform user ids).
      const approverIds = req.approverIds.length ? req.approverIds : this.opts.operatorUserIds;
      this.pending.set(token, { chatId: target.chatId, messageId, req: { ...req, approverIds }, html: text, resolve, timer });
    });
  }

  async setCommands(cmds: PlatformCommand[]): Promise<void> {
    const seen = new Set<string>();
    const commands: { command: string; description: string }[] = [];
    for (const c of cmds) {
      const name = normalizeCommandName(c.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      commands.push({ command: name, description: (c.description || "-").slice(0, 256) });
      if (commands.length >= 100) break; // Telegram limit
    }
    const r = await this.api.call("setMyCommands", { commands });
    if (r.ok) this.log.info(`telegram: registered ${commands.length} command(s)`);
    else this.log.warn(`telegram: setMyCommands failed (${r.status}): ${r.description ?? ""}`);
  }

  operatorTargets(): Target[] {
    return this.opts.operatorUserIds.map((id) => ({ platform: "telegram", chatId: id }));
  }

  /** "telegram:<chatId>" or "telegram:<chatId>:<threadId>". */
  parseTarget(s: string): Target | undefined {
    const m = /^telegram:(-?\d+)(?::(\d+))?$/.exec(s.trim());
    if (!m) return undefined;
    return { platform: "telegram", chatId: m[1]!, ...(m[2] ? { threadId: m[2] } : {}) };
  }

  /** Every chat (DM or group) is its own session: "telegram:<chatId>". */
  channelKeyForTarget(t: Target): string {
    return `telegram:${t.chatId}`;
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        const r = await this.api.call<TgUpdate[]>("getUpdates", {
          offset: this.offset, timeout: this.opts.pollSeconds, allowed_updates: ALLOWED_UPDATES,
        }, this.abort?.signal);
        if (!r.ok || !Array.isArray(r.result)) {
          if (r.status === 409) this.log.error("telegram: getUpdates 409 — another poller is using this bot token");
          else this.log.warn(`telegram: getUpdates failed (${r.status}): ${r.description ?? ""}`);
          await sleep(backoff, this.abort?.signal);
          backoff = Math.min(backoff * 2, 30_000);
          continue;
        }
        backoff = 1000;
        for (const update of r.result) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          try { await this.handleUpdate(update); }
          catch (err) { this.log.error("telegram: update handler error", { err }); }
        }
      } catch (err) {
        if (this.abort?.signal.aborted) break;
        this.log.warn("telegram: poll loop error", { err });
        await sleep(backoff, this.abort?.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Exposed for tests; normally driven by the poll loop. */
  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const msg = update.message ?? update.edited_message;
    if (!msg?.from || msg.from.is_bot) return;
    if (msg.chat.type === "channel") return;

    const fromId = String(msg.from.id);
    if (!this.opts.allowedUserIds.includes(fromId)) {
      this.log.debug(`telegram: rejected message from non-allowlisted user ${fromId}`);
      return;
    }
    const isDM = msg.chat.type === "private";
    if (!isDM && this.opts.allowedGroupIds.length > 0 && !this.opts.allowedGroupIds.includes(String(msg.chat.id))) {
      this.log.debug(`telegram: rejected message from non-allowlisted group ${msg.chat.id}`);
      return;
    }

    let text = (msg.text ?? msg.caption ?? "").trim();
    const addressed = isDM || this.isAddressed(msg, text);
    text = this.stripBotSuffix(text);
    const attachments = await this.collectAttachments(msg);
    if (!text && attachments.length === 0) return;

    const chatId = String(msg.chat.id);
    const threadId = msg.is_topic_message && msg.message_thread_id ? String(msg.message_thread_id) : undefined;
    const inbound: InboundMessage = {
      platform: "telegram",
      channelKey: `telegram:${chatId}`,
      replyTarget: { platform: "telegram", chatId, replyToMessageId: String(msg.message_id), ...(threadId ? { threadId } : {}) },
      ref: { platform: "telegram", chatId, messageId: String(msg.message_id), ...(threadId ? { threadId } : {}) },
      sender: {
        id: fromId,
        name: displayName(msg.from),
        ...(msg.from.username ? { username: msg.from.username } : {}),
        isBot: false,
      },
      trusted: this.opts.operatorUserIds.includes(fromId),
      multiparty: !isDM,
      text,
      attachments,
      addressed,
      receivedAt: Date.now(),
    };
    this.sink?.message(inbound);
  }

  /** Group message is addressed to the bot if it @mentions it, replies to it, or is a /command@bot. */
  private isAddressed(msg: TgMessage, text: string): boolean {
    const bot = this.bot;
    if (!bot) return false;
    if (msg.reply_to_message?.from?.id === bot.id) return true;
    const uname = bot.username?.toLowerCase();
    if (uname && text.toLowerCase().includes(`@${uname}`)) return true;
    for (const e of [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]) {
      if (e.type === "text_mention" && e.user?.id === bot.id) return true;
    }
    return false;
  }

  /** "/status@my_bot args" → "/status args" so commands resolve the same in groups and DMs. */
  private stripBotSuffix(text: string): string {
    const uname = this.bot?.username;
    if (!uname || !text.startsWith("/")) return text;
    return text.replace(new RegExp(`^(/[A-Za-z0-9_]+)@${escapeRe(uname)}\\b`, "i"), "$1");
  }

  private async handleCallback(cb: TgCallbackQuery): Promise<void> {
    const m = /^c:([a-f0-9]+):(\d+)$/.exec(cb.data ?? "");
    const p = m ? this.pending.get(m[1]!) : undefined;
    if (!m || !p) {
      await this.answer(cb.id, m ? "Expired" : "Unknown action");
      return;
    }
    if (!p.req.approverIds.includes(String(cb.from.id))) {
      await this.answer(cb.id, "You are not allowed to answer this");
      return;
    }
    const idx = Number(m[2]);
    if (idx < 0 || idx >= p.req.options.length) {
      await this.answer(cb.id, "Invalid option");
      return;
    }
    this.pending.delete(m[1]!);
    clearTimeout(p.timer);
    const label = p.req.options[idx]!;
    await this.answer(cb.id, label.slice(0, 190));
    await this.finishChoice(p.chatId, p.messageId, p.html, `✅ ${label} — ${displayName(cb.from)}`);
    p.resolve(idx);
  }

  /** Replace the prompt (removing its keyboard) with the outcome line on top. */
  private async finishChoice(chatId: string, messageId: number, html: string, outcome: string): Promise<void> {
    const text = `${escapeHtml(outcome)}\n\n${html}`;
    const r = await this.api.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text: text.length > TG_HTML_LIMIT ? escapeHtml(outcome) : text,
      parse_mode: "HTML", link_preview_options: { is_disabled: true },
    });
    if (!r.ok) this.log.warn(`telegram: could not update choice message (${r.status}): ${r.description ?? ""}`);
  }

  private async answer(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.api.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    } catch { /* must not throw from the poll loop */ }
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /** Best-effort: a failed download is logged and omitted. */
  private async collectAttachments(msg: TgMessage): Promise<Attachment[]> {
    const out: Attachment[] = [];
    const ts = new Date(msg.date * 1000 || Date.now()).toISOString().replace(/[:.]/g, "-");
    const scope = String(msg.chat.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1]!;
      const a = await this.download({ file_id: largest.file_id, file_size: largest.file_size }, "image", scope, `${ts}-${msg.message_id}`);
      if (a) out.push(a);
    }
    const single: [Attachment["kind"], TgFile | undefined][] = [
      ["voice", msg.voice], ["audio", msg.audio], ["video", msg.video ?? msg.video_note ?? msg.animation],
      ["file", msg.document], ["sticker", msg.sticker],
    ];
    for (const [kind, file] of single) {
      if (!file) continue;
      const a = await this.download(file, kind, scope, `${ts}-${msg.message_id}`);
      if (a) out.push(a);
    }
    return out;
  }

  private async download(file: TgFile, kind: Attachment["kind"], scope: string, prefix: string): Promise<Attachment | null> {
    try {
      const meta = await this.api.call<{ file_path?: string }>("getFile", { file_id: file.file_id });
      const filePath = meta.result?.file_path;
      if (!meta.ok || !filePath) {
        this.log.warn(`telegram: getFile failed for ${kind} (${meta.status}): ${meta.description ?? "no file_path"}`);
        return null;
      }
      const res = await fetch(this.api.fileUrl(filePath));
      if (!res.ok) {
        this.log.warn(`telegram: file download failed (${res.status})`);
        return null;
      }
      const data = new Uint8Array(await res.arrayBuffer());
      const dir = join(this.opts.attachmentsDir, "telegram", scope);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${prefix}-${kind}${extFromName(file.file_name ?? basename(filePath))}`);
      await writeFile(path, data);
      return {
        kind, path,
        ...(file.mime_type ? { mime: file.mime_type } : {}),
        ...(file.file_name ? { name: file.file_name } : {}),
        ...(file.duration !== undefined ? { durationSec: file.duration } : {}),
      };
    } catch (err) {
      this.log.warn(`telegram: attachment download error (${kind})`, { err });
      return null;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private targetFields(target: Target, withReply: boolean): Record<string, unknown> {
    return {
      chat_id: target.chatId,
      ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      ...(withReply && target.replyToMessageId
        ? { reply_parameters: { message_id: Number(target.replyToMessageId), allow_sending_without_reply: true } }
        : {}),
    };
  }

  private ref(target: Target, messageId: number): MsgRef {
    return { platform: "telegram", chatId: target.chatId, messageId: String(messageId), ...(target.threadId ? { threadId: target.threadId } : {}) };
  }
}

/** Fire `typing` now and every `intervalMs` until the returned stop() is called.
 *  Telegram's chat action expires after ~5s. */
export function startTypingPulse(adapter: Pick<PlatformAdapter, "typing">, target: Target, intervalMs = 4000): () => void {
  if (!adapter.typing) return () => {};
  void adapter.typing(target);
  const t = setInterval(() => void adapter.typing?.(target), intervalMs);
  return () => clearInterval(t);
}

function displayName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.username || String(u.id);
}

function extFromName(name: string): string {
  const m = /\.[a-zA-Z0-9]+$/.exec(name);
  return m ? m[0].toLowerCase() : "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
