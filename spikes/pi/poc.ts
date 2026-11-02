// M0 spike: self-built harness on @earendil-works/pi-coding-agent 1.4.0 SDK (in-process).
// No LLM credentials were available, so the model is pi-ai's scripted `fauxProvider`.
// That still exercises every harness mechanism uniqlaw depends on (events, tool gate,
// abort, steer/followUp, persistence, MCP, native tools, model switch, project trust);
// only "does a real model behave" is out of scope here.
// Run: bun spikes/pi/poc.ts
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import {
  createAgentSession, createMcpExtension, defineTool, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Recorder, report, sleep, startTestGateway, type ScenarioResult } from "../common/index.ts";

const DIR = import.meta.dir;
const WORK = `${DIR}/work`;
const OUT = `${DIR}/out`;
const AGENT_DIR = `${OUT}/agent-dir`; // isolated: never touch ~/.pi/agent
// Some pi internals (MCP OAuth store) call getAgentDir() directly instead of using the
// resource loader's agentDir, so the env override is required for real isolation.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
rmSync(OUT, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-a" }, { id: "faux-b" }], tokensPerSecond: 400 });
const runtime = await ModelRuntime.create({ authPath: `${AGENT_DIR}/auth.json`, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider);
const MODEL_A = runtime.getModel("faux", "faux-a")!;
const MODEL_B = runtime.getModel("faux", "faux-b")!;

type Gate = (tool: string, input: unknown) => Promise<boolean>;
const lastUser = (ctx: any) => {
  const m = [...ctx.messages].reverse().find((x: any) => x.role === "user");
  return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join("");
};
const lastToolResult = (ctx: any) => {
  const m = [...ctx.messages].reverse().find((x: any) => x.role === "toolResult");
  return m ? { text: (m.content ?? []).map((c: any) => c.text ?? "").join(""), isError: m.isError } : undefined;
};

/** Build a session the way provider-pi would: isolated agent dir, our extensions, our tools. */
async function open(rec: Recorder, opts: {
  gate?: Gate; sessionManager?: SessionManager; mcp?: { url: string }; nativeTools?: boolean; trust?: boolean | "unset";
} = {}) {
  const extension = (pi: ExtensionAPI) => {
    // Approval Broker hook: every tool call (built-in, native, MCP) passes through here.
    pi.on("tool_call", async (event: any) => {
      if (!opts.gate) return undefined;
      const id = event.toolCallId;
      rec.emit({ type: "permission_request", id, tool: event.toolName, input: event.input, title: `${event.toolName} wants to run` });
      const ok = await opts.gate(event.toolName, event.input);
      return ok ? undefined : { block: true, reason: `${event.toolName} was not approved by the operator` };
    });
    if (opts.mcp) pi.registerMcpServer("uniqlaw", { url: opts.mcp.url, exposure: "direct" } as any);
  };
  const settingsManager = SettingsManager.inMemory?.() ?? SettingsManager.create(WORK, AGENT_DIR);
  const resourceLoader = new DefaultResourceLoader({
    cwd: WORK, agentDir: AGENT_DIR, settingsManager,
    extensionFactories: [extension, ...(opts.mcp ? [createMcpExtension({ logPath: `${OUT}/mcp.log` })] : [])],
  });
  if (opts.trust === undefined || opts.trust === "unset") await resourceLoader.reload();
  else await resourceLoader.reload({ resolveProjectTrust: async () => opts.trust as boolean });

  const customTools = opts.nativeTools ? [defineTool({
    name: "uniqlaw_ping_native", label: "uniqlaw ping (native)", description: "Native in-process uniqlaw tool.",
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    async execute(_id, params) { return { content: [{ type: "text", text: `native pong (note=${params.note ?? ""})` }], details: undefined }; },
  })] : undefined;

  const { session } = await createAgentSession({
    cwd: WORK, model: MODEL_A, modelRuntime: runtime, resourceLoader, settingsManager, customTools,
    sessionManager: opts.sessionManager ?? SessionManager.inMemory(WORK),
  } as any);
  await session.bindExtensions({});
  bridge(session, rec);
  return session;
}

/** pi AgentSessionEvent → uniqlaw AgentEvent */
function bridge(session: AgentSession, rec: Recorder) {
  let turn = 0; let aborted = false;
  rec.emit({ type: "session", providerSessionId: session.sessionId });
  session.subscribe((e: any) => {
    rec.raw({ type: e.type, ...(e.type === "message_update" ? { sub: e.assistantMessageEvent?.type } : {}) });
    switch (e.type) {
      case "agent_start": turn++; aborted = false; rec.emit({ type: "turn_start", turnId: `${session.sessionId}#${turn}` }); break;
      case "message_update":
        if (e.assistantMessageEvent?.type === "text_delta") rec.emit({ type: "text", delta: e.assistantMessageEvent.delta, segmentId: String(e.message?.timestamp ?? turn) });
        else if (e.assistantMessageEvent?.type === "thinking_delta") rec.emit({ type: "thinking", text: e.assistantMessageEvent.delta });
        break;
      case "message_end":
        if (e.message?.role === "assistant") {
          if (e.message.stopReason === "aborted") aborted = true;
          const text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          if (text) rec.emit({ type: "text", final: text, segmentId: String(e.message.timestamp) });
        }
        break;
      case "tool_execution_start": rec.emit({ type: "tool_start", id: e.toolCallId, name: e.toolName, input: e.args }); break;
      case "tool_execution_end": rec.emit({ type: "tool_end", id: e.toolCallId, ok: !e.isError, summary: JSON.stringify(e.result?.content?.[0]?.text ?? "").slice(0, 120) }); break;
      case "agent_settled": rec.emit({ type: "turn_end", turnId: `${session.sessionId}#${turn}`, reason: e.aborted || aborted ? "interrupted" : "done" }); break;
    }
  });
}

const results: ScenarioResult[] = [];
const R = (n: string) => new Recorder(`${OUT}/${n}`, true);
const finalTexts = (r: Recorder) => r.events.filter((e: any) => e.type === "text" && e.final).map((e: any) => e.final);

// S1 basic
{
  const r = R("s1"); const s = await open(r);
  faux.setResponses([fauxAssistantMessage("PONG")]);
  await s.prompt("Reply with exactly: PONG");
  const deltas = r.events.filter((e: any) => e.type === "text" && e.delta).length;
  results.push({ scenario: "S1 basic", ok: finalTexts(r).includes("PONG") && r.has("turn_start") && r.has("turn_end"),
    notes: `sessionId=${s.sessionId}; ${deltas} text_delta events (token streaming); turn_end from agent_settled (agent_end may be followed by retries/queued work)` });
  s.dispose();
}

// S2 permission gate via tool_call extension handler
{
  const script = (): FauxResponseStep[] => [
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello > s2.txt" })], { stopReason: "toolUse" }),
    (ctx) => fauxAssistantMessage(lastToolResult(ctx)?.isError ? "BLOCKED" : "DONE"),
  ];
  rmSync(`${WORK}/s2.txt`, { force: true });
  const r = R("s2-allow"); const s = await open(r, { gate: async () => true });
  faux.setResponses(script()); await s.prompt("create s2.txt"); s.dispose();
  const allowed = existsSync(`${WORK}/s2.txt`) && finalTexts(r).includes("DONE");
  rmSync(`${WORK}/s2.txt`, { force: true });
  const r2 = R("s2-deny"); const s2 = await open(r2, { gate: async () => false });
  faux.setResponses(script()); await s2.prompt("create s2.txt"); s2.dispose();
  const denied = !existsSync(`${WORK}/s2.txt`) && finalTexts(r2).includes("BLOCKED");
  results.push({ scenario: "S2 tool + permission", ok: allowed && denied,
    notes: `tool_call handler awaits our async decision (= Approval Broker); allow → bash ran, file created=${allowed}; {block:true,reason} → tool result isError and model sees the reason, file absent=${denied}. Fail-closed if handler throws (per extensions.md).` });
}

// S3 interrupt
{
  const r = R("s3"); const s = await open(r);
    faux.setResponses([fauxAssistantMessage("tea ".repeat(800)), fauxAssistantMessage("STILL_HERE")]);
  const p = s.prompt("Write an 800-word essay about tea.");
  const t0 = Date.now();
  while (!r.events.some((e: any) => e.type === "text" && e.delta) && Date.now() - t0 < 10_000) await sleep(5);
  await s.abort(); await p.catch(() => {});
  const interrupted = r.events.some((e: any) => e.type === "turn_end" && e.reason === "interrupted");
  await s.prompt("Reply with exactly: STILL_HERE");
  results.push({ scenario: "S3 interrupt", ok: interrupted && finalTexts(r).includes("STILL_HERE"),
    notes: `session.abort() resolves once idle; assistant message stopReason=aborted → turn_end{interrupted}=${interrupted}; same session continues in-process (no respawn)` });
  s.dispose();
}

// S4 steer vs followUp mid-turn
{
  const r = R("s4"); const s = await open(r);
  const seen: string[] = [];
  const step = (i: number): FauxResponseStep => async (ctx) => {
    const users = ctx.messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text).join(""));
    seen.push(`call${i}: users=[${users.join(" | ")}]`);
    if (i < 3) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.5" })], { stopReason: "toolUse" });
    return fauxAssistantMessage(users.some((u) => u.includes("STEER")) ? "FINISHED (saw STEER)" : "FINISHED");
  };
  faux.setResponses([step(0), step(1), step(2), step(3), (ctx) => { seen.push(`call4: last user=${lastUser(ctx)}`); return fauxAssistantMessage(`FOLLOWUP turn, last user="${lastUser(ctx)}"`); }]);
  const p = s.prompt("run sleep three times");
  const t0 = Date.now();
  while (!r.events.some((e: any) => e.type === "tool_start") && Date.now() - t0 < 10_000) await sleep(5);
  const st = await s.steer("STEER: also mention STEER");
  const fu = await s.followUp("FOLLOWUP: second request");
  await p; await s.waitForIdle?.();
  const steerCall = seen.findIndex((x) => x.includes("STEER"));
  const followCall = seen.findIndex((x) => x.includes("FOLLOWUP"));
  r.write("calls.txt", seen.join("\n"));
  results.push({ scenario: "S4 inject", ok: steerCall > 0 && followCall > steerCall,
    notes: `steer()=${st}, followUp()=${fu}. steer text first visible to the model at LLM call #${steerCall} (right after the in-flight tool batch, same run); followUp first visible at call #${followCall} (after the run would have stopped, as a new run). finals=${JSON.stringify(finalTexts(r))}` });
  s.dispose();
}

// S5 persistence + resume
{
  const sessionDir = `${OUT}/sessions`;
  const r = R("s5a"); const s = await open(r, { sessionManager: SessionManager.create(WORK, sessionDir) });
  faux.setResponses([fauxAssistantMessage("OK")]);
  await s.prompt("Remember the code word: MANGO42. Reply with exactly: OK");
  const file = s.sessionFile!; const id = s.sessionId; s.dispose();
  const r2 = R("s5b"); const s2 = await open(r2, { sessionManager: SessionManager.open(file, sessionDir) });
  faux.setResponses([(ctx) => fauxAssistantMessage(ctx.messages.some((m: any) => JSON.stringify(m.content).includes("MANGO42")) ? "MANGO42" : "NO_HISTORY")]);
  await s2.prompt("What code word did I ask you to remember?");
  results.push({ scenario: "S5 resume", ok: finalTexts(r2).includes("MANGO42") && s2.sessionId === id,
    notes: `SessionManager.create(cwd, sessionDir) writes JSONL (${file.replace(DIR, ".")}); SessionManager.open(file) restores and the prior turn is in the model context; same sessionId=${s2.sessionId === id}. sessionDir is host-controlled → uniqlaw can keep pi sessions under .uniqlaw/` });
  s2.dispose();
}

// S6 MCP (per-session, programmatic) + native tool
{
  const gw = startTestGateway();
  const token = "pi-sess-" + Math.random().toString(36).slice(2, 8);
  const r = R("s6"); const gateSeen: string[] = [];
  const s = await open(r, { mcp: { url: gw.url(token) }, nativeTools: true, gate: async (t) => { gateSeen.push(t); return true; } });
  const active = s.getActiveToolNames();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("mcp__uniqlaw__uniqlaw_ping", { note: "s6" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("uniqlaw_ping_native", { note: "s6n" })], { stopReason: "toolUse" }),
    (ctx) => fauxAssistantMessage(`RESULTS: ${ctx.messages.filter((m: any) => m.role === "toolResult").map((m: any) => m.content.map((c: any) => c.text).join("")).join(" ; ")}`),
  ]);
  await s.prompt("ping both");
  const final = finalTexts(r).at(-1) ?? "";
  const mcpOk = gw.calls.some((c) => c.token === token) && final.includes(`caller=${token}`);
  const nativeOk = final.includes("native pong");
  results.push({ scenario: "S6 MCP + native tool", ok: mcpOk && nativeOk,
    notes: `pi.registerMcpServer("uniqlaw",{url,exposure:"direct"}) inside our inline extension → per-session MCP with no config files; tool name mcp__uniqlaw__uniqlaw_ping; gateway saw token=${gw.calls.map((c) => c.token).join(",")}; native customTools (defineTool) also work (nativeTools=true). Gate saw: ${gateSeen.join(",")} → MCP + native calls go through the same tool_call permission hook. active tools: ${active.join(",")}` });
  s.dispose(); gw.stop();
}

// S7 live model switch
{
  const r = R("s7"); const s = await open(r);
  faux.setResponses([(_c, _o, _s, m) => fauxAssistantMessage(`model=${m.id}`), (_c, _o, _s, m) => fauxAssistantMessage(`model=${m.id}`)]);
  await s.prompt("which model?");
  await s.setModel(MODEL_B);
  await s.prompt("which model now?");
  const f = finalTexts(r);
  results.push({ scenario: "S7 model switch", ok: f[0] === "model=faux-a" && f[1] === "model=faux-b",
    notes: `session.setModel() between turns, same session, history kept; finals=${JSON.stringify(f)}. pi-ai drops foreign thinking blocks on cross-provider handoff` });
  s.dispose();
}

// Trust: protected project resources in cwd under SDK mode
{
  mkdirSync(`${WORK}/.pi`, { recursive: true });
  writeFileSync(`${WORK}/.pi/APPEND_SYSTEM.md`, "TRUST_MARKER_7731\n");
  const probe = async (trust: boolean | "unset") => {
    const s = await open(R(`trust-${trust}`), { trust });
    const loaded = s.systemPrompt.includes("TRUST_MARKER_7731"); s.dispose(); return loaded;
  };
  const unset = await probe("unset"); const no = await probe(false); const yes = await probe(true);
  results.push({ scenario: "(6) project trust in SDK", ok: true,
    notes: `.pi/APPEND_SYSTEM.md in cwd: reload() with no resolver → loaded=${unset}; resolveProjectTrust→false → loaded=${no}; →true → loaded=${yes}. No prompt / no hang in SDK mode.` });
}

report(OUT, "pi-coding-agent 1.4.0 SDK (faux provider)", results);
process.exit(0);
