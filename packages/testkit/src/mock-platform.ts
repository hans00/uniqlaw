// In-memory chat platform for core unit tests.
import type {
  ChoiceRequest, InboundMessage, InboundSink, MsgRef, PlatformAdapter, PlatformCapabilities, PlatformCommand, Target,
} from "@uniqlaw/core";

export interface SentMessage { ref: MsgRef; target: Target; text: string; at: number }
export interface ChoiceAsked { target: Target; req: ChoiceRequest; resolve: (i: number | null) => void }

export class MockPlatform implements PlatformAdapter {
  readonly sent: SentMessage[] = [];
  readonly edits: { ref: MsgRef; text: string }[] = [];
  readonly deleted: MsgRef[] = [];
  readonly reactions: { ref: MsgRef; emojis: string[] }[] = [];
  readonly typings: Target[] = [];
  readonly choices: ChoiceAsked[] = [];
  commands: PlatformCommand[] = [];
  /** If set, askChoice resolves immediately with this. */
  autoChoice?: (req: ChoiceRequest) => number | null;
  operators: Target[] = [];
  private sink?: InboundSink;
  private seq = 0;
  started = false;

  constructor(readonly name = "mock", readonly capabilities: PlatformCapabilities = {
    edit: true, delete: true, reactions: true, buttons: true, typing: true, maxMessageLength: 4000,
  }) {}

  async start(sink: InboundSink) { this.sink = sink; this.started = true; }
  async stop() { this.started = false; }

  async send(target: Target, markdown: string) {
    const ref: MsgRef = { platform: this.name, chatId: target.chatId, threadId: target.threadId, messageId: `m${++this.seq}` };
    this.sent.push({ ref, target, text: markdown, at: Date.now() });
    return ref;
  }
  async edit(ref: MsgRef, markdown: string) {
    this.edits.push({ ref, text: markdown });
    const m = this.sent.find((s) => s.ref.messageId === ref.messageId);
    if (m) m.text = markdown;
    return true;
  }
  async delete(ref: MsgRef) { this.deleted.push(ref); return true; }
  async react(ref: MsgRef, emojis: string[]) { this.reactions.push({ ref, emojis }); }
  async typing(target: Target) { this.typings.push(target); }
  askChoice(target: Target, req: ChoiceRequest): Promise<number | null> {
    if (this.autoChoice) return Promise.resolve(this.autoChoice(req));
    return new Promise((resolve) => this.choices.push({ target, req, resolve }));
  }
  async setCommands(cmds: PlatformCommand[]) { this.commands = cmds; }
  operatorTargets() { return this.operators; }
  parseTarget(s: string): Target | undefined {
    const m = s.match(new RegExp(`^${this.name}:([^:]+)(?::(.+))?$`));
    return m ? { platform: this.name, chatId: m[1], threadId: m[2] } : undefined;
  }
  channelKeyForTarget(t: Target) { return `${this.name}:${t.chatId}`; }

  /** Simulate an inbound user message. */
  inject(p: Partial<InboundMessage> & { text: string; chatId?: string; senderId?: string }): InboundMessage {
    if (!this.sink) throw new Error("platform not started");
    const chatId = p.chatId ?? "c1";
    const senderId = p.senderId ?? "u1";
    const id = `in${++this.seq}`;
    const msg: InboundMessage = {
      platform: this.name,
      channelKey: p.channelKey ?? `${this.name}:${chatId}`,
      replyTarget: p.replyTarget ?? { platform: this.name, chatId, replyToMessageId: id },
      ref: p.ref ?? { platform: this.name, chatId, messageId: id },
      sender: p.sender ?? { id: senderId, name: `user-${senderId}` },
      trusted: p.trusted ?? true,
      multiparty: p.multiparty ?? false,
      text: p.text,
      attachments: p.attachments ?? [],
      addressed: p.addressed,
      receivedAt: p.receivedAt ?? Date.now(),
    };
    this.sink.message(msg);
    return msg;
  }

  texts(): string[] { return this.sent.map((s) => s.text); }
  async waitForSent(pred: (m: SentMessage) => boolean, timeoutMs = 2000): Promise<SentMessage> {
    const t0 = Date.now();
    for (;;) {
      const m = this.sent.find(pred);
      if (m) return m;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for sent message; sent=${JSON.stringify(this.texts())}`);
      await Bun.sleep(5);
    }
  }
}
