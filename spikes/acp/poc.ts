// M0 spike: ONE generic ACP client (Agent Client Protocol v1, @agentclientprotocol/sdk 2.2.0)
// run against several agents.
// Run: bun poc.ts <agent> [S1 S2 ...]      agent = gemini | opencode | <any key in AGENTS>
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import { Recorder, report, startTestGateway, sleep, type ScenarioResult } from "../common/index.ts";

const HERE = import.meta.dir;
const WORK = `${HERE}/work`;
mkdirSync(WORK, { recursive: true });

type AgentSpec = { cmd: string[]; env?: Record<string, string>; model?: string; model2?: string };
const AGENTS: Record<string, AgentSpec> = {
  gemini: { cmd: ["gemini", "--experimental-acp", "-m", process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite"],
            model2: process.env.GEMINI_MODEL2 ?? "gemini-2.5-flash" },
  "gemini-legacy": { cmd: ["gemini", "--experimental-acp", "-m", "gemini-2.5-flash-lite"] },
  opencode: { cmd: ["opencode", "acp"],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "opencode/nemotron-3.5-lightning-free",
      permission: { bash: "ask", edit: "ask" } }) },
    model2: "opencode/nemotron-3-ultra-free" },
};

const agentName = process.argv[2] ?? "gemini";
const spec = AGENTS[agentName];
if (!spec) throw new Error(`unknown agent ${agentName}`);
const OUT = `${HERE}/out/${agentName}`;
if (process.argv.length <= 3) rmSync(OUT, { recursive: true, force: true });

// ---------------------------------------------------------------- generic ACP provider
type PermDecision = "allow" | "reject";

class AcpProcess {
  proc!: ReturnType<typeof Bun.spawn>;
  conn!: acp.ClientConnection;
  init: any;
  sessions = new Map<string, AcpSession>();
  stderr = "";

  async start() {
    this.proc = Bun.spawn(spec.cmd, { cwd: WORK, env: { ...process.env, ...spec.env } as any,
      stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    (async () => { for await (const c of this.proc.stderr as any) this.stderr += new TextDecoder().decode(c); })();
    const stdin = this.proc.stdin as any;
    const output = new WritableStream<Uint8Array>({ write(chunk) { stdin.write(chunk); stdin.flush?.(); } });
    const stream = acp.ndJsonStream(output, this.proc.stdout as ReadableStream<Uint8Array>);
    const app = acp.client({ name: "uniqlaw-spike" })
      .onNotification("session/update", ({ params }: any) => this.sessions.get(params.sessionId)?.onUpdate(params.update))
      .onNotification("*", ({ params: n, method }: any) => { n = { method, n }; new Recorder(OUT, true).write("unhandled-notifications.jsonl", n); })
      .onRequest("session/request_permission", async ({ params }: any) => {
        const s = this.sessions.get(params.sessionId);
        return s ? s.onPermission(params) : { outcome: { outcome: "cancelled" } };
      })
      .onRequest("*", async (req: any) => { req = { method: req.method, params: req.params }; throw new Error(`unhandled client request ${JSON.stringify(req).slice(0, 100)}`); });
    this.conn = app.connect(stream);
    this.init = await this.req("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "uniqlaw-spike", version: "0.0.0" },
    });
    return this.init;
  }
  req(method: string, params: any): Promise<any> {
    // ClientConnection exposes the same request() as ClientContext
    return (this.conn.agent as any).request(method, params);
  }
  notify(method: string, params: any) { return (this.conn.agent as any).notify(method, params); }
  async stop() { try { this.proc.kill(); await this.proc.exited; } catch {} }
}

class AcpSession {
  rec: Recorder;
  turn = 0;
  permissionDecision: PermDecision = "allow";
  segment = 0;
  textBuf = "";
  onFirstText?: () => void;
  toolTitles = new Map<string, string>();
  lastPermissionOptions: any[] = [];
  newResult: any;

  constructor(public p: AcpProcess, public id: string, name: string) {
    this.rec = new Recorder(`${OUT}/${name}`);
    p.sessions.set(id, this);
    this.rec.emit({ type: "session", providerSessionId: id });
  }
  onUpdate(u: any) {
    this.rec.raw(u);
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") {
          this.textBuf += u.content.text;
          this.rec.emit({ type: "text", delta: u.content.text, segmentId: `${this.id}:${this.turn}:${this.segment}` });
          const f = this.onFirstText; this.onFirstText = undefined; f?.();
        }
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.rec.emit({ type: "thinking", text: u.content.text });
        break;
      case "tool_call":
        this.flushText();
        this.toolTitles.set(u.toolCallId, u.title);
        this.rec.emit({ type: "tool_start", id: u.toolCallId, name: u.kind ?? u.title, input: u.rawInput ?? u.title });
        if (u.status === "completed" || u.status === "failed")
          this.rec.emit({ type: "tool_end", id: u.toolCallId, ok: u.status === "completed" });
        break;
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed")
          this.rec.emit({ type: "tool_end", id: u.toolCallId, ok: u.status === "completed",
            summary: JSON.stringify(u.content ?? u.rawOutput ?? "").slice(0, 120) });
        break;
    }
  }
  flushText() {
    if (this.textBuf) {
      this.rec.emit({ type: "text", final: this.textBuf, segmentId: `${this.id}:${this.turn}:${this.segment}` });
      this.textBuf = ""; this.segment++;
    }
  }
  async onPermission(params: any) {
    const tc = params.toolCall ?? {};
    this.lastPermissionOptions = params.options;
    this.rec.emit({ type: "permission_request", id: tc.toolCallId ?? "?", tool: tc.kind ?? tc.title ?? "?",
      input: tc.rawInput ?? tc.title, title: tc.title ?? "" });
    const kind = this.permissionDecision === "allow" ? "allow_once" : "reject_once";
    const opt = params.options.find((o: any) => o.kind === kind) ?? params.options.find((o: any) => o.kind.startsWith(this.permissionDecision));
    return { outcome: { outcome: "selected", optionId: opt.optionId } };
  }
  /** Runs one prompt turn to completion. */
  async prompt(text: string) {
    const turnId = `${this.id}:${++this.turn}`;
    this.rec.emit({ type: "turn_start", turnId });
    try {
      const res = await this.p.req("session/prompt", { sessionId: this.id, prompt: [{ type: "text", text }] });
      this.flushText();
      this.rec.emit({ type: "turn_end", turnId, reason: res.stopReason === "cancelled" ? "interrupted" : "done", usage: res.usage });
      return res;
    } catch (e: any) {
      this.flushText();
      this.rec.emit({ type: "error", error: String(e?.message ?? e).slice(0, 200), fatal: false });
      this.rec.emit({ type: "turn_end", turnId, reason: "error" });
      return { error: String(e?.message ?? e) };
    }
  }
  cancel() { return this.p.notify("session/cancel", { sessionId: this.id }); }
  lastFinal() { return (this.rec.events.filter((e: any) => e.type === "text" && e.final !== undefined).at(-1) as any)?.final ?? ""; }
}

async function newSession(p: AcpProcess, name: string, mcpServers: any[] = []) {
  const r = await p.req("session/new", { cwd: WORK, mcpServers });
  const s = new AcpSession(p, r.sessionId, name);
  s.newResult = r;
  s.rec.write("session-new.json", r);
  return s;
}

// ---------------------------------------------------------------- scenarios
const results: ScenarioResult[] = [];
const want = new Set(process.argv.slice(3));
const run = async (name: string, fn: () => Promise<ScenarioResult>) => {
  if (want.size && !want.has(name)) return;
  console.log(`\n=== ${agentName} ${name}`);
  try { results.push(await Promise.race([fn(), sleep(240_000).then(() => { throw new Error("scenario timeout"); })])); }
  catch (e) { results.push({ scenario: name, ok: false, notes: `threw: ${e}` }); }
  console.log(" ->", JSON.stringify(results.at(-1)));
};

const gw = startTestGateway();
let p = new AcpProcess();
const init = await p.start();
new Recorder(OUT, true).write("initialize.json", init);
console.log("initialize:", JSON.stringify(init).slice(0, 600));
const caps = init.agentCapabilities ?? {};
let resume: { id: string } | undefined;

await run("S1", async () => {
  const s = await newSession(p, "S1");
  const r = await s.prompt("Reply with exactly: PONG");
  resume = { id: s.id };
  const deltas = s.rec.events.filter((e: any) => e.type === "text" && e.delta).length;
  return { scenario: "S1 basic", ok: /PONG/.test(s.lastFinal()),
    notes: `stopReason=${r.stopReason ?? r.error}; text chunks=${deltas}; session/new keys=${Object.keys(s.newResult).join(",")}` };
});

await run("S2", async () => {
  for (const f of ["s2.txt", "s2b.txt"]) rmSync(`${WORK}/${f}`, { force: true });
  const s = await newSession(p, "S2");
  s.permissionDecision = "allow";
  await s.prompt(`Use your shell tool to run exactly: echo hi > ${WORK}/s2.txt   Then reply DONE.`);
  const approved = existsSync(`${WORK}/s2.txt`);
  const n1 = s.rec.events.filter((e) => e.type === "permission_request").length;
  s.permissionDecision = "reject";
  await s.prompt(`Use your shell tool to run exactly: echo hi > ${WORK}/s2b.txt   Then reply DONE.`);
  const denied = !existsSync(`${WORK}/s2b.txt`);
  const n2 = s.rec.events.filter((e) => e.type === "permission_request").length - n1;
  return { scenario: "S2 tool+permission", ok: approved && denied && n1 > 0 && n2 > 0,
    notes: `session/request_permission options kinds=${s.lastPermissionOptions.map((o: any) => o.kind).join("/")}; allow→file=${approved} (prompts=${n1}); reject→absent=${denied} (prompts=${n2})` };
});

await run("S3", async () => {
  const s = await newSession(p, "S3");
  let fired = false;
  s.onFirstText = () => { fired = true; s.cancel(); };
  const r = await s.prompt("Write an 800-word essay about the history of lighthouses. Do not use any tools.");
  const r2 = await s.prompt("Reply with exactly: STILL-HERE");
  return { scenario: "S3 interrupt", ok: fired && r.stopReason === "cancelled" && /STILL-HERE/.test(s.lastFinal()),
    notes: `session/cancel notification after first chunk; stopReason=${r.stopReason ?? r.error}; continue=${/STILL-HERE/.test(s.lastFinal())}` };
});

await run("S4", async () => {
  const s = await newSession(p, "S4");
  s.permissionDecision = "allow";
  let second: Promise<any> | undefined; const order: string[] = [];
  const origOnUpdate = s.onUpdate.bind(s);
  s.onUpdate = (u: any) => {
    if (u.sessionUpdate === "tool_call") order.push(`tool:${u.title}`);
    if (!second && u.sessionUpdate === "tool_call") {
      order.push("INJECT-SENT");
      second = p.req("session/prompt", { sessionId: s.id, prompt: [{ type: "text", text: "Additionally: end your final reply with the word INJECTED." }] })
        .then((r) => { order.push(`second-prompt-resolved:${r.stopReason}`); return r; }, (e) => { order.push(`second-prompt-error:${String(e?.message ?? e).slice(0, 80)}`); return { error: String(e) }; });
    }
    origOnUpdate(u);
  };
  const r1 = await s.prompt("Run these three shell commands, strictly one per tool call, sequentially: `sleep 3`, `sleep 3`, `sleep 3`. After all three finish, reply DONE.");
  order.push(`first-prompt-resolved:${r1.stopReason ?? r1.error}`);
  const r2 = second ? await second : undefined;
  return { scenario: "S4 inject", ok: !!second,
    notes: `no steer method in ACP v1 (methods: session/prompt|cancel|load|set_mode|set_config_option…). Concurrent second session/prompt during a turn → order: ${order.join(" → ")}; final text has INJECTED=${/INJECTED/.test(s.textBuf + s.lastFinal())}; r2=${JSON.stringify(r2).slice(0, 120)}` };
});

await run("S5", async () => {
  if (!resume) return { scenario: "S5 resume", ok: "n/a", notes: "no S1 session" };
  if (!caps.loadSession) return { scenario: "S5 resume", ok: false, notes: `agent does not advertise loadSession (caps=${JSON.stringify(caps).slice(0, 200)})` };
  await p.stop();
  p = new AcpProcess(); await p.start();
  const s = new AcpSession(p, resume.id, "S5");
  const replayStart = s.rec.events.length;
  const lr = await p.req("session/load", { sessionId: resume.id, cwd: WORK, mcpServers: [] });
  const replayed = s.rec.events.length - replayStart;
  s.textBuf = ""; // discard replayed history text
  await s.prompt("What exact word did I ask you to reply with in my first message? Answer with just that word.");
  return { scenario: "S5 resume", ok: /PONG/.test(s.lastFinal()),
    notes: `new process + session/load (replays history as session/update: ${replayed} events; load result keys=${Object.keys(lr ?? {}).join(",")}); answer="${s.lastFinal().trim().slice(0, 40)}"; sessionCapabilities=${JSON.stringify(caps.sessionCapabilities ?? {})}` };
});

await run("S6", async () => {
  const http = caps.mcpCapabilities?.http;
  const uniqueNames = process.env.ACP_MCP_UNIQUE === "1";
  const mk = (tok: string) => [{ type: "http", name: uniqueNames ? `uniqlaw_${tok}` : "uniqlaw", url: gw.url(tok), headers: [] }];
  const sA = await newSession(p, "S6a", mk("acpA"));
  const sB = await newSession(p, "S6b", mk("acpB"));
  const b0 = gw.calls.length;
  await sA.prompt("List the exact names of every tool you have whose name contains 'ping' (one per line), then call one of them exactly once with note 'from-A' and reply with its output.");
  const callsA = gw.calls.slice(b0).map((c) => c.token);
  const b1 = gw.calls.length;
  await sB.prompt("Call the uniqlaw_ping tool exactly once with note 'from-B', then reply with its output.");
  const callsB = gw.calls.slice(b1).map((c) => c.token);
  const ok = callsA.length > 0 && callsA.every((t) => t === "acpA") && callsB.length > 0 && callsB.every((t) => t === "acpB");
  return { scenario: "S6 MCP", ok,
    notes: `names=${uniqueNames ? "unique per session" : "same name 'uniqlaw'"}; mcpCapabilities=${JSON.stringify(caps.mcpCapabilities ?? {})}; per-session session/new mcpServers[{type:http}] in ONE process: A calls=${JSON.stringify(callsA)} B calls=${JSON.stringify(callsB)}; perms asked=${sA.rec.events.filter((e) => e.type === "permission_request").length + sB.rec.events.filter((e) => e.type === "permission_request").length}` };
});

await run("S7", async () => {
  const s = await newSession(p, "S7");
  const nr = s.newResult;
  const notes: string[] = [`session/new: models=${JSON.stringify(nr.models ?? null).slice(0, 160)}; configOptions=${JSON.stringify((nr.configOptions ?? []).map((o: any) => ({ id: o.id, category: o.category, cur: o.currentValue }))).slice(0, 200)}; modes=${JSON.stringify(nr.modes?.availableModes?.map((m: any) => m.id) ?? null)}`];
  let switched = false;
  const modelOpt = (nr.configOptions ?? []).find((o: any) => o.category === "model" || o.id === "model");
  const target = spec.model2;
  if (modelOpt && target) {
    const values = (modelOpt.options ?? []).flatMap((o: any) => o.options ?? [o]).map((o: any) => o.value);
    const v = values.find((x: string) => x === target || x.endsWith(target)) ?? values.find((x: string) => x !== modelOpt.currentValue);
    try { const r = await p.req("session/set_config_option", { sessionId: s.id, configId: modelOpt.id, value: v }); switched = true; notes.push(`set_config_option(${modelOpt.id}=${v}) ok → ${JSON.stringify(r).slice(0, 120)}`); }
    catch (e) { notes.push(`set_config_option failed: ${String(e).slice(0, 120)}`); }
  }
  if (!switched && nr.models && target) {
    const ids = nr.models.availableModels?.map((m: any) => m.modelId) ?? [];
    const v = ids.find((x: string) => x === target || x.endsWith(target)) ?? ids.find((x: string) => x !== nr.models.currentModelId);
    try { await p.req("session/set_model", { sessionId: s.id, modelId: v }); switched = true; notes.push(`session/set_model(${v}) ok (unstable/legacy method)`); }
    catch (e) { notes.push(`session/set_model failed: ${String(e).slice(0, 120)}`); }
  }
  const r = await s.prompt("Reply with exactly: TWO");
  return { scenario: "S7 model switch", ok: switched && /TWO/.test(s.lastFinal()), notes: notes.join(" | ") + ` | after: ${r.stopReason ?? r.error}` };
});

await p.stop(); gw.stop();
new Recorder(OUT, true).write("stderr-tail.txt", p.stderr.slice(-3000));
report(OUT, `acp/${agentName} (${spec.cmd.join(" ")})`, results);
process.exit(0);
