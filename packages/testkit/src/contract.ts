// Provider contract suite (docs §12). Every adapter runs the same scenarios
// against a real backend; declared capabilities must actually hold.
// Real-LLM runs are gated behind UNIQLAW_E2E=1.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, AgentSession, PermissionPolicy, SessionSpec } from "@uniqlaw/core";
import { DEFAULT_PERMISSIONS } from "@uniqlaw/core";
import { startTestGateway } from "./gateway.ts";

export interface ContractOptions {
  /** Display name. */
  name?: string;
  model?: string;
  /** Model for S7 setModel. */
  altModel?: string;
  /** Working dir root; default packages/testkit/.work/<provider>. */
  workDir?: string;
  instanceId?: string;
  timeoutMs?: number;
  skip?: string[];
  /** Force-run even without UNIQLAW_E2E. */
  force?: boolean;
  profileOptions?: Record<string, unknown>;
}

/** Background consumer of session.events with waitFor helpers. */
export class EventCollector {
  readonly events: AgentEvent[] = [];
  autoAllow = true;
  private done = false;

  constructor(readonly session: AgentSession) {
    void (async () => {
      for await (const ev of session.events) {
        this.events.push(ev);
        if (ev.type === "permission_request" && this.autoAllow) {
          void session.respondPermission?.(ev.id, { behavior: "allow" });
        }
      }
      this.done = true;
    })();
  }

  async waitFor<T extends AgentEvent>(pred: (e: AgentEvent) => e is T, timeoutMs: number, from?: number): Promise<T>;
  async waitFor(pred: (e: AgentEvent) => boolean, timeoutMs: number, from?: number): Promise<AgentEvent>;
  async waitFor(pred: (e: AgentEvent) => boolean, timeoutMs: number, from = 0): Promise<AgentEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`timeout after ${timeoutMs}ms; events=${JSON.stringify(this.events.map((e) => e.type))}`);
      }
      if (this.done) throw new Error(`event stream ended; events=${JSON.stringify(this.events.map((e) => e.type))}`);
      await Bun.sleep(50);
    }
  }

  /** Wait for the next turn_end after index `from`. */
  turnEnd(timeoutMs: number, from = 0) {
    return this.waitFor((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end", timeoutMs, from) as
      Promise<Extract<AgentEvent, { type: "turn_end" }>>;
  }

  texts(from = 0): string {
    return this.events.slice(from).map((e) => (e.type === "text" ? (e.final ?? e.delta ?? "") : "")).join("\n");
  }
  mark() { return this.events.length; }
}

const text = (t: string) => ({ text: t, attachments: [] });

export function runProviderContract(provider: AgentProvider, o: ContractOptions = {}) {
  const enabled = o.force || process.env.UNIQLAW_E2E === "1";
  const d = enabled ? describe : describe.skip;
  const T = o.timeoutMs ?? 240_000;
  const work = o.workDir ?? join(import.meta.dir, "..", ".work", provider.name);
  const instanceId = o.instanceId ?? "contract";
  const open: AgentSession[] = [];
  const run = Date.now().toString(36);
  const skip = new Set(o.skip ?? []);
  const t = (id: string, name: string, fn: () => Promise<void>) =>
    (skip.has(id) ? test.skip : test)(`${id} ${name}`, fn, T);

  const spec = (sessionId: string, extra: Partial<SessionSpec> & { permissions?: Partial<PermissionPolicy> } = {}): SessionSpec => {
    mkdirSync(work, { recursive: true });
    const { permissions, ...rest } = extra;
    return {
      sessionId: `${sessionId}-${run}`,
      cwd: work,
      instanceId,
      env: {},
      systemPrompt: { fragments: [] },
      profile: {
        name: "contract", provider: provider.name, model: o.model ?? "haiku",
        permissions: { ...DEFAULT_PERMISSIONS, allowTools: [], ...permissions },
        options: o.profileOptions ?? {},
      },
      ...rest,
    };
  };
  const openS = async (s: SessionSpec) => {
    const sess = await provider.open(s);
    open.push(sess);
    return { sess, ev: new EventCollector(sess) };
  };

  d(`provider contract: ${o.name ?? provider.name}`, () => {
    afterEach(async () => {
      for (const s of open.splice(0)) await s.close().catch(() => {});
    });

    t("S1", "basic turn", async () => {
      const { sess, ev } = await openS(spec("s1"));
      await ev.waitFor((e) => e.type === "session", 5000);
      const m = ev.mark();
      await sess.send(text("Reply with exactly: PONG"));
      await ev.waitFor((e) => e.type === "turn_start", 30_000, m);
      const end = await ev.turnEnd(120_000, m);
      expect(end.reason).toBe("done");
      expect(ev.texts(m)).toContain("PONG");
    });

    t("S1b", "native cross-session tools disabled", async () => {
      const { sess, ev } = await openS(spec("s1b"));
      const m = ev.mark();
      await sess.send(text("Do you currently have tools named ListAgents or SendMessage available? Answer exactly NONE if neither, otherwise list the ones you have."));
      await ev.turnEnd(120_000, m);
      expect(ev.texts(m)).toContain("NONE");
    });

    t("S2", "permission allow + deny", async () => {
      if (!provider.capabilities(spec("x").profile).permissionCallback) return;
      const { sess, ev } = await openS(spec("s2"));
      ev.autoAllow = false;
      const f1 = join(work, `s2-${run}.txt`), f2 = join(work, `s2-deny-${run}.txt`);
      rmSync(f1, { force: true }); rmSync(f2, { force: true });
      let m = ev.mark();
      await sess.send(text(`Use the Bash tool to run exactly: touch ${f1}\nThen reply DONE.`));
      const p1 = await ev.waitFor((e) => e.type === "permission_request", 120_000, m);
      if (p1.type !== "permission_request") throw new Error("unreachable");
      await sess.respondPermission!(p1.id, { behavior: "allow" });
      await ev.turnEnd(120_000, m);
      expect(existsSync(f1)).toBe(true);

      m = ev.mark();
      await sess.send(text(`Use the Bash tool to run exactly: touch ${f2}\nThen reply DONE.`));
      const p2 = await ev.waitFor((e) => e.type === "permission_request", 120_000, m);
      if (p2.type !== "permission_request") throw new Error("unreachable");
      await sess.respondPermission!(p2.id, { behavior: "deny" });
      await ev.turnEnd(120_000, m);
      expect(existsSync(f2)).toBe(false);
    });

    t("S3", "interrupt", async () => {
      const { sess, ev } = await openS(spec("s3"));
      let m = ev.mark();
      await sess.send(text("Write a 1500-word essay about the history of tea. Do not use any tools."));
      await ev.waitFor((e) => e.type === "turn_start", 30_000, m);
      await Bun.sleep(4000);
      await sess.interrupt!();
      const end = await ev.turnEnd(60_000, m);
      expect(end.reason).toBe("interrupted");
      m = ev.mark();
      await sess.send(text("Reply with exactly: STILL_HERE"));
      await ev.turnEnd(120_000, m);
      expect(ev.texts(m)).toContain("STILL_HERE");
    });

    t("S4", "steer mid-turn", async () => {
      if (!provider.capabilities(spec("x").profile).steer) return;
      const { sess, ev } = await openS(spec("s4", { permissions: { allowTools: ["Bash"] } }));
      const m = ev.mark();
      await sess.send(text("Use the Bash tool three separate times, one call per message, sequentially: `sleep 3 && echo A`, then `sleep 3 && echo B`, then `sleep 3 && echo C`. After all three, reply with the letters you saw."));
      await ev.waitFor((e) => e.type === "tool_start", 120_000, m);
      await sess.steer!(text("Also: end your final reply with the word INJECTED."));
      await ev.turnEnd(180_000, m);
      // Allow a trailing turn if the provider queued instead of steering.
      const deadline = Date.now() + 60_000;
      while (!ev.texts(m).includes("INJECTED") && Date.now() < deadline) await Bun.sleep(500);
      expect(ev.texts(m)).toContain("INJECTED");
      const ends = ev.events.slice(m).filter((e) => e.type === "turn_end").length;
      expect(ends).toBe(1); // true steer: one turn
    });

    t("S5", "resume after close", async () => {
      const code = `MANGO-${Math.floor(Math.random() * 900 + 100)}`;
      const s = spec("s5");
      const a = await openS(s);
      const sid = (await a.ev.waitFor((e) => e.type === "session", 5000)) as Extract<AgentEvent, { type: "session" }>;
      let m = a.ev.mark();
      await a.sess.send(text(`Remember the codeword ${code}. Reply with exactly: NOTED`));
      await a.ev.turnEnd(120_000, m);
      await a.sess.close();
      const b = await openS({ ...s, providerSessionId: sid.providerSessionId });
      m = b.ev.mark();
      await b.sess.send(text("What codeword did I ask you to remember? Answer with just the codeword."));
      await b.ev.turnEnd(120_000, m);
      expect(b.ev.texts(m)).toContain(code);
    });

    t("S6", "MCP gateway identity", async () => {
      const gw = startTestGateway();
      try {
        const token = `tok-s6-${run}`;
        const { sess, ev } = await openS(spec("s6", { mcp: { url: gw.url(token), token, toolNames: ["uniqlaw_ping"] } }));
        const m = ev.mark();
        await sess.send(text("Call the uniqlaw_ping tool with note 'hello', then reply with its output verbatim."));
        await ev.turnEnd(120_000, m);
        expect(gw.calls.map((c) => c.token)).toContain(token);
        expect(ev.texts(m)).toContain(`caller=${token}`);
      } finally { gw.stop(); }
    });

    t("S6b", "cross-session MCP isolation", async () => {
      const gw = startTestGateway();
      try {
        const ta = `tok-a-${run}`, tb = `tok-b-${run}`;
        const A = await openS(spec("s6a", { mcp: { url: gw.url(ta), token: ta, toolNames: ["uniqlaw_ping"] } }));
        const B = await openS(spec("s6b", { mcp: { url: gw.url(tb), token: tb, toolNames: ["uniqlaw_ping"] } }));
        const ma = A.ev.mark(), mb = B.ev.mark();
        const ask = "Call the uniqlaw_ping tool exactly once with note 'iso', then reply with its output verbatim.";
        await Promise.all([A.sess.send(text(ask)), B.sess.send(text(ask))]);
        await Promise.all([A.ev.turnEnd(150_000, ma), B.ev.turnEnd(150_000, mb)]);
        expect(A.ev.texts(ma)).toContain(`caller=${ta}`);
        expect(A.ev.texts(ma)).not.toContain(tb);
        expect(B.ev.texts(mb)).toContain(`caller=${tb}`);
        expect(B.ev.texts(mb)).not.toContain(ta);
      } finally { gw.stop(); }
    });

    t("S7", "setModel", async () => {
      const caps = provider.capabilities(spec("x").profile);
      if (caps.modelSwitch !== "live") return;
      const { sess, ev } = await openS(spec("s7"));
      let m = ev.mark();
      await sess.send(text("Reply with exactly: ONE"));
      await ev.turnEnd(120_000, m);
      m = ev.mark();
      await sess.setModel!(o.altModel ?? "sonnet");
      const me = await ev.waitFor((e) => e.type === "model", 30_000, m);
      expect(me.type).toBe("model");
      m = ev.mark();
      await sess.send(text("Reply with exactly: TWO"));
      await ev.turnEnd(120_000, m);
      expect(ev.texts(m)).toContain("TWO");
    });
  });
}
