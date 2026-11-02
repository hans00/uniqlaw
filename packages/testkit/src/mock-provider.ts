// Scriptable in-memory provider for core unit tests.
import type {
  AgentEvent, AgentProvider, AgentSession, PermissionDecision, Profile, ProviderCapabilities, SessionSpec, TurnInput,
} from "@uniqlaw/core";
import { AsyncQueue } from "./queue.ts";

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  streaming: "final", interrupt: true, steer: true, resume: "native", denyEndsTurn: false, modelSwitch: "live",
  permissionCallback: true, mcp: "per-session", nativeTools: true, attachments: ["image", "file"], slashCommands: true,
};

export type MockBehavior = (input: TurnInput, s: MockSession) => void | Promise<void>;

/** Default: one turn echoing the input. */
export const echoBehavior: MockBehavior = (input, s) => {
  s.turn([{ type: "text", segmentId: `s${s.sends.length}`, final: `echo: ${input.text}` }]);
};

export class MockSession implements AgentSession {
  readonly events = new AsyncQueue<AgentEvent>();
  readonly sends: TurnInput[] = [];
  readonly steers: TurnInput[] = [];
  readonly permissionResponses: { id: string; decision: PermissionDecision; optionIndex?: number }[] = [];
  readonly inputResponses: { id: string; value: string }[] = [];
  readonly models: string[] = [];
  interrupts = 0;
  closed = false;
  running = false;
  private turnSeq = 0;
  currentTurn = "";

  constructor(readonly spec: SessionSpec, readonly capabilities: ProviderCapabilities, private behavior: MockBehavior,
    readonly providerSessionId: string) {
    this.emit({ type: "session", providerSessionId });
  }

  emit(ev: AgentEvent) { this.events.push(ev); }

  /** Emit a full turn: turn_start, events, turn_end. */
  turn(evs: AgentEvent[], reason: "done" | "interrupted" | "error" = "done") {
    const id = this.startTurn();
    for (const e of evs) this.emit(e);
    this.endTurn(reason, id);
  }
  startTurn(): string {
    this.currentTurn = `t${++this.turnSeq}`;
    this.running = true;
    this.emit({ type: "turn_start", turnId: this.currentTurn });
    return this.currentTurn;
  }
  endTurn(reason: "done" | "interrupted" | "error" = "done", id = this.currentTurn, error?: string) {
    this.running = false;
    this.emit({ type: "turn_end", turnId: id, reason, ...(error ? { error } : {}) });
  }
  setBehavior(b: MockBehavior) { this.behavior = b; }

  async send(input: TurnInput) { this.sends.push(input); await this.behavior(input, this); }
  async steer(input: TurnInput) { this.steers.push(input); }
  async interrupt() { this.interrupts++; if (this.running) this.endTurn("interrupted"); }
  async setModel(model: string) { this.models.push(model); this.emit({ type: "model", model }); }
  async respondPermission(id: string, decision: PermissionDecision, optionIndex?: number) {
    this.permissionResponses.push({ id, decision, optionIndex });
  }
  async respondInput(id: string, value: string) { this.inputResponses.push({ id, value }); }
  async close() { this.closed = true; this.events.end(); }
  async alive() { return !this.closed; }
}

export class MockProvider implements AgentProvider {
  readonly sessions: MockSession[] = [];
  behavior: MockBehavior = echoBehavior;
  openError?: Error;
  private seq = 0;

  constructor(readonly name = "mock", readonly caps: ProviderCapabilities = MOCK_CAPABILITIES) {}

  capabilities(_p: Profile) { return this.caps; }

  async open(spec: SessionSpec): Promise<AgentSession> {
    if (this.openError) throw this.openError;
    const s = new MockSession(spec, this.caps, this.behavior, spec.providerSessionId ?? `mock-${++this.seq}`);
    this.sessions.push(s);
    return s;
  }

  last(): MockSession | undefined { return this.sessions.at(-1); }
  bySession(id: string): MockSession | undefined { return this.sessions.filter((s) => s.spec.sessionId === id).at(-1); }
}
