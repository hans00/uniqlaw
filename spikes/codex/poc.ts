// M0 spike: drive `codex app-server` (stdio JSON-RPC) and map onto AgentEvent.
// Run: bun poc.ts [S1 S2 ...]   (default: all)
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { AppServer } from "./rpc.ts";
import { Recorder, report, sleep, startTestGateway, type ScenarioResult } from "../common/index.ts";

const HERE = import.meta.dir;
const WORK = resolve(HERE, "work");
const OUT = resolve(HERE, "out");
const MODEL = process.env.CODEX_MODEL ?? "gpt-6-luna";
const MODEL_ALT = process.env.CODEX_MODEL_ALT ?? "gpt-5.6-luna";
const EFFORT = "low";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const rec = new Recorder(OUT);
const results: ScenarioResult[] = [];
const want = new Set(process.argv.slice(2));
const run = (s: string) => want.size === 0 || want.has(s);

// ---------- adapter-ish wrapper ----------
type Approver = (method: string, params: any) => any;

class CodexSession {
  threadId = "";
  activeTurnId = "";
  turnWaiters = new Map<string, (turn: any) => void>();
  approver: Approver = () => ({ decision: "decline" });
  onEvent: (method: string, params: any) => void = () => {};
  settingsUpdates: any[] = [];

  constructor(public s: AppServer) {
    s.onRaw = (f) => rec.raw(f);
    s.onNotification = (m, p) => this.notif(m, p);
    s.onServerRequest = (m, p, id) => this.serverReq(m, p, id!);
  }

  private notif(m: string, p: any) {
    if (p?.threadId && this.threadId && p.threadId !== this.threadId && !m.startsWith("thread/")) return;
    this.onEvent(m, p);
    switch (m) {
      case "turn/started":
        this.activeTurnId = p.turn.id;
        rec.emit({ type: "turn_start", turnId: p.turn.id });
        break;
      case "item/agentMessage/delta":
        rec.emit({ type: "text", delta: p.delta, segmentId: p.itemId });
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        rec.emit({ type: "thinking", text: p.delta });
        break;
      case "item/started": {
        const it = p.item;
        if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall"].includes(it.type))
          rec.emit({ type: "tool_start", id: it.id, name: it.type === "mcpToolCall" ? `mcp:${it.server}/${it.tool}` : it.type, input: it.command ?? it.arguments ?? it.changes ?? null });
        break;
      }
      case "item/completed": {
        const it = p.item;
        if (it.type === "agentMessage") rec.emit({ type: "text", final: it.text, segmentId: it.id });
        else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall"].includes(it.type))
          rec.emit({ type: "tool_end", id: it.id, ok: !["failed", "declined"].includes(it.status), summary: String(it.status) });
        break;
      }
      case "turn/completed": {
        const t = p.turn;
        rec.emit({ type: "turn_end", turnId: t.id, reason: t.status === "completed" ? "done" : t.status === "interrupted" ? "interrupted" : "error" });
        this.activeTurnId = "";
        const w = this.turnWaiters.get(t.id) ?? this.turnWaiters.get("*");
        this.turnWaiters.delete(t.id); this.turnWaiters.delete("*");
        w?.(t);
        break;
      }
      case "thread/settings/updated":
        this.settingsUpdates.push(p.threadSettings);
        break;
      case "error":
        rec.emit({ type: "error", error: JSON.stringify(p.error).slice(0, 300), fatal: !p.willRetry });
        break;
    }
  }

  private serverReq(m: string, p: any, id: number | string) {
    if (m.endsWith("requestApproval") || m === "applyPatchApproval" || m === "execCommandApproval") {
      rec.emit({ type: "permission_request", id: String(p.approvalId ?? p.itemId ?? id), tool: m, input: p.command ?? p.reason ?? p.permissions ?? null, title: p.reason ?? p.command ?? m });
      this.s.respond(id, this.approver(m, p));
    } else {
      rec.emit({ type: "error", error: `unhandled server request ${m}`, fatal: false });
      this.s.respond(id, {});
    }
  }

  async start(params: any = {}) {
    const r = await this.s.request("thread/start", { model: MODEL, cwd: WORK, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false, ...params });
    this.threadId = r.thread.id;
    rec.emit({ type: "session", providerSessionId: this.threadId });
    return r;
  }

  async resume(threadId: string, params: any = {}) {
    const r = await this.s.request("thread/resume", { threadId, cwd: WORK, ...params, excludeTurns: true });
    this.threadId = r.thread.id;
    rec.emit({ type: "session", providerSessionId: this.threadId });
    return r;
  }

  /** Start a turn and return {turnId, done} where done resolves on turn/completed. */
  async turn(text: string, extra: any = {}) {
    let resolveDone!: (t: any) => void;
    const done = new Promise<any>((r) => (resolveDone = r));
    this.turnWaiters.set("*", resolveDone);
    const r = await this.s.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text, text_elements: [] }], effort: EFFORT, ...extra });
    // re-key the waiter to the concrete turn id
    if (this.turnWaiters.get("*") === resolveDone) { this.turnWaiters.delete("*"); this.turnWaiters.set(r.turn.id, resolveDone); }
    return { turnId: r.turn.id as string, done };
  }

  steer(text: string, expectedTurnId: string) {
    return this.s.request("turn/steer", { threadId: this.threadId, expectedTurnId, input: [{ type: "text", text, text_elements: [] }] });
  }
  interrupt(turnId: string) { return this.s.request("turn/interrupt", { threadId: this.threadId, turnId }); }
}

const finalText = (t: any) => (t.items ?? []).filter((i: any) => i.type === "agentMessage").map((i: any) => i.text).join("\n");
const textsSince = (n: number) => rec.events.slice(n).filter((e) => e.type === "text" && e.final).map((e: any) => e.final).join("\n");
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout: ${label}`); })]) as Promise<T>;

async function main() {
  const gw = startTestGateway();
  let server = new AppServer();
  await server.init();
  let sess = new CodexSession(server);
  await sess.start({ developerInstructions: "You are running inside uniqlaw (spike). Be terse." });
  const firstThread = sess.threadId;
  console.log("thread", firstThread);

  // ---- S1 basic ----
  if (run("S1")) {
    console.log("\n== S1 basic");
    const n = rec.events.length;
    const { done } = await sess.turn("Reply with exactly: PONG");
    const t = await withTimeout(done, 120_000, "S1");
    const evs = rec.events.slice(n);
    const deltas = evs.filter((e) => e.type === "text" && e.delta).length;
    const txt = finalText(t) || textsSince(n);
    results.push({ scenario: "S1 basic", ok: /PONG/.test(txt) && t.status === "completed",
      notes: `final="${txt.trim()}", status=${t.status}, agentMessage deltas=${deltas} (granularity: ${deltas > 1 ? "token" : deltas === 1 ? "single delta" : "final only"})` });
  }

  // ---- S2 tool + permission ----
  if (run("S2")) {
    console.log("\n== S2 permission");
    rmSync(resolve(WORK, "s2.txt"), { force: true });
    rmSync(resolve(WORK, "s2b.txt"), { force: true });
    const seen: string[] = [];
    sess.approver = (m, p) => { seen.push(`${m}${p.command ? `(${p.command})` : ""}`); return { decision: "accept" }; };
    let r = await sess.turn("Use the shell to run exactly this command: `touch s2.txt` Then reply DONE.", { approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots: [WORK], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
    let t = await withTimeout(r.done, 180_000, "S2a");
    const accepted = existsSync(resolve(WORK, "s2.txt"));
    const seenA = [...seen]; seen.length = 0;
    sess.approver = (m, p) => { seen.push(`${m}${p.command ? `(${p.command})` : ""}`); return { decision: "decline" }; };
    r = await sess.turn("Use the shell to run exactly this command: `touch s2b.txt` If it is not allowed, do not retry and reply DENIED.", { approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots: [WORK], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
    t = await withTimeout(r.done, 180_000, "S2b");
    const declined = !existsSync(resolve(WORK, "s2b.txt"));
    results.push({ scenario: "S2 tool+permission", ok: seenA.length > 0 && accepted && seen.length > 0 && declined,
      notes: `approve: requests=[${seenA.join(", ")}] file=${accepted}; deny: requests=[${seen.join(", ")}] fileAbsent=${declined}, reply="${finalText(t).trim().slice(0, 80)}"` });
    sess.approver = () => ({ decision: "decline" });
  }

  // ---- S3 interrupt ----
  if (run("S3")) {
    console.log("\n== S3 interrupt");
    let firstDeltaAt = 0; let gotDelta!: () => void;
    const deltaP = new Promise<void>((r) => (gotDelta = r));
    sess.onEvent = (m) => { if (m === "item/agentMessage/delta" && !firstDeltaAt) { firstDeltaAt = Date.now(); gotDelta(); } };
    const r = await sess.turn("Write an 800-word essay about the history of the printing press. No tools.");
    await withTimeout(deltaP, 120_000, "S3 first delta");
    const t0 = Date.now();
    await sess.interrupt(r.turnId);
    const t = await withTimeout(r.done, 60_000, "S3 interrupted completion");
    const latency = Date.now() - t0;
    sess.onEvent = () => {};
    const r2 = await sess.turn("Reply with exactly: STILL_HERE");
    const t2 = await withTimeout(r2.done, 120_000, "S3 follow-up");
    results.push({ scenario: "S3 interrupt", ok: t.status === "interrupted" && /STILL_HERE/.test(finalText(t2)),
      notes: `turn/interrupt → turn/completed status=${t.status} after ${latency}ms; follow-up="${finalText(t2).trim()}"` });
  }

  // ---- S4 inject (turn/steer) ----
  if (run("S4")) {
    console.log("\n== S4 steer");
    const order: string[] = [];
    let firstCmd!: () => void; const firstCmdP = new Promise<void>((r) => (firstCmd = r));
    sess.onEvent = (m, p) => {
      if (m === "item/started" || m === "item/completed") order.push(`${m === "item/started" ? "+" : "-"}${p.item.type}${p.item.type === "commandExecution" ? `(${p.item.command})` : p.item.type === "userMessage" ? `(${JSON.stringify(p.item.content?.[0]?.text ?? "").slice(0, 40)})` : ""}@${p.turnId?.slice(-6)}`);
      if (m === "item/started" && p.item.type === "commandExecution") firstCmd();
      if (m === "thread/queue/changed") order.push("queue/changed");
    };
    const r = await sess.turn("Run these three shell commands one at a time, as three separate tool calls: `sleep 3`, then `sleep 3`, then `sleep 3`. After all three, reply with the word FINISHED.");
    await withTimeout(firstCmdP, 120_000, "S4 first command");
    const steerRes: any = await sess.steer("IMPORTANT NEW INSTRUCTION: still run all three sleeps, and your final reply must be exactly: FINISHED INJECTED", r.turnId);
    order.push(`steer→turnId=${steerRes.turnId.slice(-6)}`);
    const t = await withTimeout(r.done, 240_000, "S4 completion");
    const txt = finalText(t);
    sess.onEvent = () => {};
    const sameTurn = steerRes.turnId === r.turnId;
    // also: steer with stale expectedTurnId should fail
    let staleErr = "";
    try { await sess.steer("x", r.turnId); } catch (e: any) { staleErr = e.message.slice(0, 160); }
    results.push({ scenario: "S4 inject (steer)", ok: sameTurn && /INJECTED/.test(txt),
      notes: `steer returned same turnId=${sameTurn}; final="${txt.trim().slice(0, 80)}"; item order: ${order.join(" ")}; steer on idle thread → ${staleErr || "no error"}` });
  }

  // ---- S7 model switch ----
  if (run("S7")) {
    console.log("\n== S7 model switch");
    const before = sess.settingsUpdates.length;
    const r = await sess.turn("Reply with exactly: SWITCHED", { model: MODEL_ALT });
    const t = await withTimeout(r.done, 120_000, "S7");
    const upd = sess.settingsUpdates.slice(before);
    // read back via thread/resume on a running thread (rejoin) to see the effective model
    const rr: any = await server.request("thread/resume", { threadId: sess.threadId, excludeTurns: true });
    results.push({ scenario: "S7 model switch", ok: rr.model === MODEL_ALT && /SWITCHED/.test(finalText(t)),
      notes: `turn/start {model:"${MODEL_ALT}"} (persists for later turns); thread/settings/updated=${JSON.stringify(upd.map((u) => u.model ?? u)).slice(0, 120)}; resume reports model=${rr.model}; no separate thread/settings/update request exists in 0.166` });
  }

  // ---- S5 resume after process restart ----
  if (run("S5")) {
    console.log("\n== S5 resume");
    await server.close();
    server = new AppServer();
    await server.init();
    sess = new CodexSession(server);
    const rr: any = await sess.resume(firstThread);
    const r = await sess.turn("What exact word did I first ask you to reply with in this conversation? Reply with just that word.");
    const t = await withTimeout(r.done, 120_000, "S5");
    results.push({ scenario: "S5 resume", ok: /PONG/.test(finalText(t)),
      notes: `new app-server process, thread/resume {threadId} ok (model=${rr.model}); answer="${finalText(t).trim()}"` });
  }

  // ---- S6 MCP per thread ----
  if (run("S6")) {
    console.log("\n== S6 MCP");
    const mk = async (token: string) => {
      const ss = new CodexSession(server);
      await ss.start({ config: { mcp_servers: { uniqlaw: { url: gw.url(token), default_tools_approval_mode: "approve" } } } });
      return ss;
    };
    // two threads in ONE process with different tokens → per-thread binding?
    const a = await mk("codex-thread-A");
    const ra = await a.turn("Call the uniqlaw_ping tool from the uniqlaw MCP server with note \"A\" and reply with its exact output.");
    const ta = await withTimeout(ra.done, 180_000, "S6 A");
    const b = await mk("codex-thread-B");
    const rb = await b.turn("Call the uniqlaw_ping tool from the uniqlaw MCP server with note \"B\" and reply with its exact output.");
    const tb = await withTimeout(rb.done, 180_000, "S6 B");
    const tokens = gw.calls.map((c) => `${c.token}:${(c.args as any)?.note}`);
    const ok = gw.calls.some((c) => c.token === "codex-thread-A" && (c.args as any)?.note === "A") && gw.calls.some((c) => c.token === "codex-thread-B" && (c.args as any)?.note === "B");
    results.push({ scenario: "S6 MCP", ok,
      notes: `thread/start {config:{mcp_servers:{uniqlaw:{url}}}} per thread in one process; gateway saw [${tokens.join(", ")}]; A="${finalText(ta).trim().slice(0, 60)}" B="${finalText(tb).trim().slice(0, 60)}"` });
  }

  report(OUT, "codex (app-server 0.166.0)", results);
  await server.close();
  gw.stop();
}

main().catch(async (e) => {
  console.error("FATAL", e);
  report(OUT, "codex (app-server 0.166.0)", [...results, { scenario: "fatal", ok: false, notes: String(e?.message ?? e) }]);
  process.exit(1);
});
