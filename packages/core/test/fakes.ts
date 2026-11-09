import {
  type AgentEvent, type AgentProvider, type AgentSession, type ChoiceRequest, type MsgRef, type OutboundFile,
  type PermissionDecision, type PlatformAdapter, type ProviderCapabilities, type Target, type TurnInput,
} from "../src/index.ts";

// ── fakes ──────────────────────────────────────────────────────────────────

export type Script = (input: TurnInput, s: FakeSession) => Promise<void> | void;

export class FakeSession implements AgentSession {
  sent: TurnInput[] = [];
  steered: TurnInput[] = [];
  permissions: { id: string; d: PermissionDecision; idx?: number }[] = [];
  interrupted = 0;
  closed = false;
  private q: AgentEvent[] = [];
  private wake?: () => void;
  private n = 0;
  constructor(readonly capabilities: ProviderCapabilities, private script: Script) {}
  emit(...evs: AgentEvent[]) { this.q.push(...evs); this.wake?.(); }
  turnId() { return `t${this.n}`; }
  async send(input: TurnInput) { this.sent.push(input); this.n++; this.emit({ type: "turn_start", turnId: this.turnId() }); await this.script(input, this); }
  async steer(input: TurnInput) { this.steered.push(input); }
  async interrupt() { this.interrupted++; this.emit({ type: "turn_end", turnId: this.turnId(), reason: "interrupted" }); }
  models: string[] = [];
  async setModel(m: string) { this.models.push(m); }
  async respondPermission(id: string, d: PermissionDecision, idx?: number) { this.permissions.push({ id, d, idx }); }
  async close() { this.closed = true; this.wake?.(); }
  async alive() { return !this.closed; }
  events = { [Symbol.asyncIterator]: () => ({
    next: async (): Promise<IteratorResult<AgentEvent>> => {
      while (!this.q.length && !this.closed) await new Promise<void>((r) => (this.wake = r));
      if (this.closed && !this.q.length) return { done: true, value: undefined };
      return { done: false, value: this.q.shift()! };
    },
  }) };
}

export const CAPS: ProviderCapabilities = { streaming: "segment", interrupt: true, steer: true, resume: "native", denyEndsTurn: false,
  modelSwitch: "live", permissionCallback: true, mcp: "per-session", nativeTools: false, attachments: [], slashCommands: true };

export class FakeProvider implements AgentProvider {
  name = "fake";
  sessions = new Map<string, FakeSession>();
  constructor(public script: Script, public caps: ProviderCapabilities = CAPS) {}
  capabilities() { return this.caps; }
  /** Every open() spec (profile name/model, system prompt…), in order. */
  specs: { sessionId: string; cwd?: string; providerSessionId?: string; profile?: { name: string; model?: string }; systemPrompt?: { fragments: { id: string; text?: string }[] } }[] = [];
  async open(spec: { sessionId: string }) {
    this.specs.push(spec);
    const s = new FakeSession(this.caps, this.script);
    this.sessions.set(spec.sessionId, s);
    s.emit({ type: "session", providerSessionId: `p-${spec.sessionId}` });
    return s;
  }
}

export class FakePlatform implements PlatformAdapter {
  name = "tg";
  capabilities = { edit: true, delete: true, reactions: true, buttons: true, typing: true, maxMessageLength: 4096 };
  sent: { target: Target; text: string }[] = [];
  reactions: { ref: MsgRef; emojis: string[] }[] = [];
  choices: ChoiceRequest[] = [];
  choiceAnswer: number | null = 0;
  async start(_sink?: import("../src/index.ts").InboundSink) {}
  async stop() {}
  async send(target: Target, text: string) { this.sent.push({ target, text }); return { platform: "tg", chatId: target.chatId, messageId: String(this.sent.length) }; }
  edits: { ref: MsgRef; text: string }[] = [];
  deletes: MsgRef[] = [];
  async edit(ref: MsgRef, text: string) { this.edits.push({ ref, text }); return true; }
  async delete(ref: MsgRef) { this.deletes.push(ref); return true; }
  async react(ref: MsgRef, emojis: string[]) { this.reactions.push({ ref, emojis }); }
  paired: string[] = [];
  setPairedUsers(ids: string[]) { this.paired = ids; }
  files: { target: Target; file: OutboundFile }[] = [];
  async sendFile(target: Target, file: OutboundFile) { this.files.push({ target, file }); return { platform: "tg", chatId: target.chatId, messageId: `f${this.files.length}` }; }
  async askChoice(_t: Target, req: ChoiceRequest) { this.choices.push(req); return this.choiceAnswer; }
  operatorTargets() { return [{ platform: "tg", chatId: "1" }]; }
  parseTarget(s: string) { const [p, id] = s.split(":"); return p === "tg" && id ? { platform: "tg", chatId: id } : undefined; }
  channelKeyForTarget(t: Target) { return `tg:${t.chatId}`; }
}

