// DM pairing (after OpenClaw): a stranger who DMs the bot gets a one-time code; an operator approves
// it from chat (`/pair approve <code>`) or the CLI. Approved users are kept in state.db (never written
// back to settings.json) and handed to the platform adapter as a separate "paired" set, so they are
// accepted like allowedUserIds but never become operators.
import { randomInt } from "node:crypto";
import type { Settings } from "./config.ts";
import type { Logger } from "./plugin.ts";
import type { PlatformAdapter, Target, UnknownSender } from "./platform.ts";
import type { StateStore } from "./state.ts";

export interface PairingRequest { code: string; platform: string; userId: string; name: string; username?: string; replyTarget: Target; createdAt: number; expiresAt: number }
export interface PairedUser { platform: string; userId: string; name: string; approvedAt: number }

const PENDING = "pairing:pending:";
const APPROVED = "pairing:approved:";
// No 0/O/1/I/L: codes get read aloud and retyped on phones.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function normalizeCode(code: string): string { return code.toUpperCase().replace(/[^A-Z0-9]/g, ""); }
const pretty = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export class PairingService {
  constructor(private readonly deps: { store: StateStore; settings: Settings; platforms: Map<string, PlatformAdapter>; log: Logger }) {}

  /** Hand every adapter its paired set (startup, and after each change). */
  sync(platform?: string) {
    const all = this.paired();
    for (const [name, p] of this.deps.platforms) {
      if (platform && name !== platform) continue;
      p.setPairedUsers?.(all.filter((u) => u.platform === name).map((u) => u.userId));
    }
  }

  pending(): PairingRequest[] {
    const now = Date.now();
    const out: PairingRequest[] = [];
    for (const [k, v] of this.deps.store.entries(PENDING)) {
      const r = JSON.parse(v) as PairingRequest;
      if (r.expiresAt <= now) this.deps.store.del(k);
      else out.push(r);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  paired(): PairedUser[] { return this.deps.store.entries(APPROVED).map(([, v]) => JSON.parse(v) as PairedUser); }

  /** A stranger DMed the bot: issue a code once (repeat messages while it is pending stay unanswered). */
  async onUnknownSender(s: UnknownSender): Promise<void> {
    const cfg = this.deps.settings.pairing;
    if (!cfg.enabled) return;
    const platform = this.deps.platforms.get(s.platform);
    if (!platform || !platform.setPairedUsers) return; // adapter can't accept paired users
    const open = this.pending();
    if (open.some((r) => r.platform === s.platform && r.userId === s.userId)) return;
    if (open.filter((r) => r.platform === s.platform).length >= cfg.maxPending) {
      this.deps.log.warn("pairing: too many open requests; ignoring", { platform: s.platform, userId: s.userId });
      return;
    }
    let code: string;
    do code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    while (this.deps.store.get(PENDING + code));
    const now = Date.now();
    const req: PairingRequest = { code, platform: s.platform, userId: s.userId, name: s.name, ...(s.username ? { username: s.username } : {}),
      replyTarget: { platform: s.replyTarget.platform, chatId: s.replyTarget.chatId }, createdAt: now, expiresAt: now + cfg.ttlMinutes * 60_000 };
    this.deps.store.set(PENDING + code, JSON.stringify(req));
    this.deps.log.info("pairing: request", { platform: s.platform, userId: s.userId, name: s.name });
    await platform.send(s.replyTarget, `This assistant is private. To get access, ask its owner to approve pairing code **${pretty(code)}** (valid for ${cfg.ttlMinutes} minutes).`)
      .catch((e) => this.deps.log.warn("pairing: reply failed", { e: String(e) }));
    const who = `${s.name}${s.username ? ` (@${s.username})` : ""}`;
    const note = `🔑 Pairing request from ${who} on ${s.platform} (id ${s.userId}).\nApprove: /pair approve ${pretty(code)} — or deny: /pair deny ${pretty(code)}\n(CLI: uniqlaw pairing approve ${pretty(code)})`;
    for (const p of this.deps.platforms.values()) {
      for (const t of p.operatorTargets()) await p.send(t, note).catch((e) => this.deps.log.warn("pairing: operator notify failed", { e: String(e) }));
    }
  }

  async approve(code: string): Promise<PairedUser> {
    const req = this.take(code);
    const user: PairedUser = { platform: req.platform, userId: req.userId, name: req.name, approvedAt: Date.now() };
    this.deps.store.set(`${APPROVED}${req.platform}:${req.userId}`, JSON.stringify(user));
    this.sync(req.platform);
    this.deps.log.info("pairing: approved", { platform: req.platform, userId: req.userId });
    await this.deps.platforms.get(req.platform)?.send(req.replyTarget, "✅ You're paired — you can talk to me now.").catch(() => {});
    return user;
  }

  deny(code: string): PairingRequest {
    const req = this.take(code);
    this.deps.log.info("pairing: denied", { platform: req.platform, userId: req.userId });
    return req;
  }

  /** Remove a paired user (allowedUserIds from settings are not affected). */
  revoke(platform: string, userId: string): boolean {
    const k = `${APPROVED}${platform}:${userId}`;
    if (!this.deps.store.get(k)) return false;
    this.deps.store.del(k);
    this.sync(platform);
    this.deps.log.info("pairing: revoked", { platform, userId });
    return true;
  }

  private take(code: string): PairingRequest {
    const k = PENDING + normalizeCode(code);
    const v = this.deps.store.get(k);
    const req = v ? (JSON.parse(v) as PairingRequest) : undefined;
    if (!req || req.expiresAt <= Date.now()) { if (v) this.deps.store.del(k); throw new Error(`no open pairing request with code ${code}`); }
    this.deps.store.del(k);
    return req;
  }

  /** `/pair [approve|deny <code>]` from an operator in any chat. */
  async command(arg?: string): Promise<string> {
    const [action, code] = (arg ?? "").trim().split(/\s+/);
    try {
      if (action === "approve" && code) { const u = await this.approve(code); return `✅ Paired ${u.name} on ${u.platform} (id ${u.userId}).`; }
      if (action === "deny" && code) { const r = this.deny(code); return `🚫 Denied ${r.name} on ${r.platform}.`; }
    } catch (e) { return `⚠️ ${e instanceof Error ? e.message : String(e)}`; }
    const open = this.pending();
    const lines = open.map((r) => `- ${pretty(r.code)}: ${r.name}${r.username ? ` (@${r.username})` : ""} on ${r.platform} (id ${r.userId})`);
    const paired = this.paired().map((u) => `- ${u.name} on ${u.platform} (id ${u.userId})`);
    return [open.length ? `Open requests:\n${lines.join("\n")}` : "No open pairing requests.",
      paired.length ? `Paired users:\n${paired.join("\n")}` : "", "Use /pair approve <code> or /pair deny <code>; remove a user with `uniqlaw pairing revoke <platform> <userId>`."]
      .filter(Boolean).join("\n\n");
  }
}
