// M0 spike: OpenCode via `opencode serve` (raw HTTP + SSE).
// Run: bun poc.ts [S1 S2 ...]   (default: all)
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Recorder, report, startTestGateway, sleep, type ScenarioResult } from "../common/index.ts";

const HERE = import.meta.dir;
const WORK = `${HERE}/work`;
const OUT = `${HERE}/out`;
mkdirSync(WORK, { recursive: true });
if (process.argv.length <= 2) rmSync(OUT, { recursive: true, force: true });

const MODEL = { providerID: "opencode", modelID: process.env.OC_MODEL ?? "nemotron-3.5-lightning-free" };
const MODEL2 = { providerID: "opencode", modelID: process.env.OC_MODEL2 ?? "nemotron-3.5-super-vl-free" };

// ---------------------------------------------------------------- server mgmt
class Serve {
  proc?: ReturnType<typeof Bun.spawn>;
  constructor(public port: number, public extraConfig?: object) {}
  get base() { return `http://127.0.0.1:${this.port}`; }
  async start() {
    const env: Record<string, string> = { ...process.env } as any;
    if (this.extraConfig) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(this.extraConfig);
    this.proc = Bun.spawn(["opencode", "serve", "--port", String(this.port), "--hostname", "127.0.0.1"],
      { cwd: WORK, env, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${this.base}/global/health`)).ok) return; } catch {}
      await sleep(250);
    }
    throw new Error("serve did not start");
  }
  async stop() { this.proc?.kill(); await this.proc?.exited; }
}

// ---------------------------------------------------------------- client
const DIR = encodeURIComponent(WORK);
type Raw = { type: string; properties: any };

class OcClient {
  listeners = new Set<(e: Raw) => void>();
  private abort = new AbortController();
  constructor(public s: Serve) {}
  async api(method: string, path: string, body?: unknown) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${this.s.base}${path}${sep}directory=${DIR}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : null;
  }
  async connect() {
    const res = await fetch(`${this.s.base}/event?directory=${DIR}`, { signal: this.abort.signal });
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
            if (data) { const e = JSON.parse(data); for (const l of this.listeners) l(e); }
          }
        }
      } catch {}
    })();
  }
  close() { this.abort.abort(); }
}

/** One uniqlaw session ↔ one opencode session. Maps raw events → AgentEvent. */
class OcSession {
  rec: Recorder;
  turn = 0;
  idleWaiters: (() => void)[] = [];
  permissionHandler: (p: any) => "once" | "always" | "reject" = () => "once";
  textParts = new Map<string, string>(); // partID -> text
  partType = new Map<string, string>();
  toolSeen = new Set<string>();
  msgRole = new Map<string, string>();
  assistantModels: string[] = [];
  userMsgOrder: string[] = []; // order of user/assistant/tool happenings for inject analysis
  lastError?: any;
  awaitingBusy = false; // set on send; idle only counts after a busy was observed
  staleIdles = 0;
  inTurn = false;

  constructor(public c: OcClient, public id: string, name: string) {
    this.rec = new Recorder(`${OUT}/${name}`);
    this.rec.emit({ type: "session", providerSessionId: id });
    c.listeners.add((e) => this.onRaw(e));
  }

  private onRaw(e: Raw) {
    const p = e.properties ?? {};
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (sid !== this.id) return;
    if (!/^(file\.watcher|lsp\.|plugin\.added|session\.updated|session\.diff)/.test(e.type)) this.rec.raw(e);
    switch (e.type) {
      case "message.updated": {
        const info = p.info;
        if (!this.msgRole.has(info.id)) {
          this.msgRole.set(info.id, info.role);
          this.userMsgOrder.push(`${info.role}:${info.id}`);
        }
        if (info.role === "assistant" && info.modelID) this.assistantModels.push(`${info.providerID}/${info.modelID}`);
        if (info.error) this.lastError = info.error;
        break;
      }
      case "message.part.updated": {
        const part = p.part;
        this.partType.set(part.id, part.type);
        if (part.type === "text" && this.msgRole.get(part.messageID) === "assistant" && part.time?.end) {
          this.rec.emit({ type: "text", final: part.text, segmentId: part.id });
        }
        if (part.type === "reasoning" && part.time?.end) this.rec.emit({ type: "thinking", text: part.text });
        if (part.type === "tool") {
          const st = part.state;
          if ((st.status === "running" || st.status === "pending") && !this.toolSeen.has(part.callID)) {
            this.toolSeen.add(part.callID);
            this.userMsgOrder.push(`tool_start:${part.tool}`);
            this.rec.emit({ type: "tool_start", id: part.callID, name: part.tool, input: st.input });
          }
          if (st.status === "completed" || st.status === "error") {
            this.userMsgOrder.push(`tool_end:${part.tool}`);
            this.rec.emit({ type: "tool_end", id: part.callID, ok: st.status === "completed",
              summary: (st.output ?? st.error ?? "").toString().slice(0, 120) });
          }
        }
        // step-start = one LLM step inside the run loop (not a uniqlaw turn); turn_start is emitted on busy.
        break;
      }
      case "message.part.delta": {
        if (this.partType.get(p.partID) === "text")
          this.rec.emit({ type: "text", delta: p.delta, segmentId: p.partID });
        break;
      }
      case "permission.asked":
      case "permission.v2.asked": {
        const req = p;
        this.rec.emit({ type: "permission_request", id: req.id, tool: req.permission ?? req.action,
          input: req.patterns ?? req.resources, title: `${req.permission ?? req.action} ${(req.patterns ?? req.resources ?? []).join(" ")}` });
        const reply = this.permissionHandler(req);
        this.c.api("POST", `/permission/${req.id}/reply`, { reply }).catch((err) => this.rec.raw({ replyErr: String(err) }));
        break;
      }
      case "session.error":
        this.lastError = p.error;
        this.rec.emit({ type: "error", error: JSON.stringify(p.error).slice(0, 200), fatal: false });
        break;
      case "session.status": {
        if (p.status?.type === "busy") {
          if (this.awaitingBusy || this.userMsgOrder.at(-1) === "idle" || this.turn === 0) {
            if (!this.inTurn) { this.lastError = undefined; this.inTurn = true; this.rec.emit({ type: "turn_start", turnId: `${this.id}:${++this.turn}` }); }
          }
          this.awaitingBusy = false;
        }
        break;
      }
      case "session.idle": {
        if (this.awaitingBusy) { this.staleIdles++; this.rec.raw({ note: "stale session.idle ignored" }); break; }
        if (this.userMsgOrder.at(-1) === "idle") { this.staleIdles++; break; } // duplicate idle
        this.inTurn = false;
        const aborted = this.lastError?.name === "MessageAbortedError";
        this.rec.emit({ type: "turn_end", turnId: `${this.id}:${this.turn}`, reason: aborted ? "interrupted" : this.lastError ? "error" : "done" });
        this.lastError = undefined;
        this.userMsgOrder.push("idle");
        const w = this.idleWaiters; this.idleWaiters = []; w.forEach((f) => f());
        break;
      }
    }
  }

  idle(timeoutMs = 120_000) {
    return Promise.race([
      new Promise<void>((r) => this.idleWaiters.push(r)),
      sleep(timeoutMs).then(() => { throw new Error("timeout waiting idle"); }),
    ]);
  }
  send(text: string, extra: object = {}) {
    this.awaitingBusy = true;
    return this.c.api("POST", `/session/${this.id}/prompt_async`, { model: MODEL, parts: [{ type: "text", text }], ...extra });
  }
  interrupt() { return this.c.api("POST", `/session/${this.id}/abort`); }
  finalText() {
    return this.rec.events.filter((e) => e.type === "text" && e.final !== undefined).map((e: any) => e.final).join("\n");
  }
  lastFinal() {
    const t = this.rec.events.filter((e) => e.type === "text" && e.final !== undefined) as any[];
    return t.at(-1)?.final ?? "";
  }
}

async function newSession(c: OcClient, name: string, body: object = {}) {
  const s = await c.api("POST", "/session", { title: `uniqlaw-spike ${name}`, ...body });
  return new OcSession(c, s.id, name);
}

const ASK_ALL = [
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
];

// ---------------------------------------------------------------- scenarios
const results: ScenarioResult[] = [];
const want = new Set(process.argv.slice(2));
const run = async (name: string, fn: () => Promise<ScenarioResult>) => {
  if (want.size && !want.has(name)) return;
  console.log(`\n=== ${name}`);
  try { results.push(await fn()); } catch (e) { results.push({ scenario: name, ok: false, notes: `threw: ${e}` }); }
  console.log(" ->", JSON.stringify(results.at(-1)));
};

const gw = startTestGateway();
let serve = new Serve(4921);
await serve.start();
let client = new OcClient(serve); await client.connect();
let resumeId = "";

await run("S1", async () => {
  const s = await newSession(client, "S1");
  await s.send("Reply with exactly: PONG"); await s.idle();
  resumeId = s.id;
  const deltas = s.rec.events.filter((e: any) => e.type === "text" && e.delta).length;
  const ok = s.rec.has("turn_start") && /PONG/.test(s.finalText()) && s.rec.has("turn_end");
  return { scenario: "S1 basic", ok, notes: `session=${s.id}; text deltas=${deltas} (token streaming via message.part.delta); turn end = session.idle` };
});

await run("S2", async () => {
  for (const f of ["s2.txt", "s2b.txt"]) rmSync(`${WORK}/${f}`, { force: true });
  const s = await newSession(client, "S2", { permission: ASK_ALL });
  s.permissionHandler = () => "once";
  await s.send(`Use the bash tool to run exactly: echo hi > ${WORK}/s2.txt   Then reply DONE.`); await s.idle();
  const approved = existsSync(`${WORK}/s2.txt`);
  const n1 = s.rec.events.filter((e) => e.type === "permission_request").length;
  s.permissionHandler = () => "reject";
  await s.send(`Use the bash tool to run exactly: echo hi > ${WORK}/s2b.txt   Then reply DONE.`); await s.idle();
  const denied = !existsSync(`${WORK}/s2b.txt`);
  const n2 = s.rec.events.filter((e) => e.type === "permission_request").length - n1;
  return { scenario: "S2 tool+permission", ok: approved && denied && n1 > 0 && n2 > 0,
    notes: `per-session ruleset via POST /session {permission:[...ask]}; event permission.asked; reply POST /permission/:id/reply {reply:once|always|reject}; approve→file=${approved} (prompts=${n1}); reject→absent=${denied} (prompts=${n2})` };
});

await run("S3", async () => {
  const s = await newSession(client, "S3");
  let fired = false;
  client.listeners.add((e) => {
    if (!fired && e.type === "message.part.delta" && e.properties.sessionID === s.id && s.partType.get(e.properties.partID) === "text") {
      fired = true; s.interrupt();
    }
  });
  await s.send("Write an 800-word essay about the history of lighthouses. No tools.");
  await s.idle(180_000);
  const end = s.rec.events.filter((e) => e.type === "turn_end").at(-1) as any;
  await s.send("Reply with exactly: STILL-HERE"); await s.idle();
  const cont = /STILL-HERE/.test(s.lastFinal());
  return { scenario: "S3 interrupt", ok: fired && end?.reason === "interrupted" && cont,
    notes: `POST /session/:id/abort after first text delta; turn_end.reason=${end?.reason} (MessageAbortedError on assistant msg); continue after abort=${cont}` };
});

await run("S4", async () => {
  const s = await newSession(client, "S4", { permission: [{ permission: "bash", pattern: "*", action: "allow" }] });
  let injected = false; let injectAt = "";
  client.listeners.add((e) => {
    if (!injected && e.type === "message.part.updated" && e.properties.part?.sessionID === s.id &&
        e.properties.part.type === "tool" && e.properties.part.state.status === "running") {
      injected = true; injectAt = new Date().toISOString();
      s.userMsgOrder.push("INJECT-SENT");
      s.send("Additionally: end your final reply with the word INJECTED.");
    }
  });
  await s.send("Run these three shell commands with the bash tool, strictly one per tool call, sequentially: `sleep 3`, `sleep 3`, `sleep 3`. After all three finish, reply DONE.");
  await s.idle(180_000);
  // There may be a second idle if the injected message ran as its own turn.
  await Promise.race([s.idle(60_000).catch(() => {}), sleep(20_000)]);
  const order = s.userMsgOrder.join(" → ");
  const idles = s.userMsgOrder.filter((x) => x === "idle").length;
  const iInj = s.userMsgOrder.indexOf("INJECT-SENT");
  const after = s.userMsgOrder.slice(iInj + 1);
  const firstIdleAfterInject = after.indexOf("idle");
  const userBeforeIdle = after.slice(0, firstIdleAfterInject).some((x) => x.startsWith("user:"));
  const toolsAfterUser = (() => { const i = after.findIndex((x) => x.startsWith("user:")); return i >= 0 ? after.slice(i).filter((x) => x.startsWith("tool_start")).length : -1; })();
  const finalHasInjected = /INJECTED/.test(s.finalText());
  return { scenario: "S4 inject", ok: injected,
    notes: `prompt_async while busy accepted (204). order: ${order}. idles=${idles}; user msg admitted before first idle=${userBeforeIdle}; tool_starts after injected user msg=${toolsAfterUser}; final mentions INJECTED=${finalHasInjected}` };
});

await run("S5", async () => {
  if (!resumeId) return { scenario: "S5 resume", ok: "n/a", notes: "no S1 session" };
  client.close(); await serve.stop();
  serve = new Serve(4922); await serve.start();
  client = new OcClient(serve); await client.connect();
  const msgs = await client.api("GET", `/session/${resumeId}/message`);
  const s = new OcSession(client, resumeId, "S5");
  await s.send("What exact word did I ask you to reply with in my first message? Answer with just that word."); await s.idle();
  const ok = /PONG/.test(s.lastFinal());
  return { scenario: "S5 resume", ok, notes: `restarted opencode serve (new port); same session id reused directly (history in ~/.local/share/opencode storage, ${msgs.length} msgs found); answer="${s.lastFinal().trim().slice(0, 40)}"` };
});

await run("S6", async () => {
  // (a) runtime POST /mcp — process-wide registry; two "uniqlaw sessions" share one serve.
  await client.api("POST", "/mcp", { name: "uc_A", config: { type: "remote", url: gw.url("sessA"), oauth: false } });
  await client.api("POST", "/mcp", { name: "uc_B", config: { type: "remote", url: gw.url("sessB"), oauth: false } });
  const status = await client.api("GET", "/mcp");
  const ids: string[] = await client.api("GET", "/experimental/tool/ids");
  const ucTools = ids.filter((i) => i.startsWith("uc_"));
  // isolate by per-session permission ruleset: session A denies uc_B_*.
  const denyB = [{ permission: "uc_B_*", pattern: "*", action: "deny" }];
  const sA = await newSession(client, "S6a", { permission: denyB });
  const before = gw.calls.length;
  await sA.send("Call the uniqlaw_ping tool exactly once with note 'from-A' (use whichever uniqlaw_ping tool you have), then reply with its output."); await sA.idle();
  const callsA = gw.calls.slice(before).map((c) => c.token);
  // per-message tool filter alternative
  const sA2 = await newSession(client, "S6b");
  const before2 = gw.calls.length;
  await sA2.send("Call the uniqlaw_ping tool exactly once with note 'from-A2', then reply with its output.", { tools: { "uc_B_uniqlaw_ping": false } }); await sA2.idle();
  const callsA2 = gw.calls.slice(before2).map((c) => c.token);

  // (b) per-process config via OPENCODE_CONFIG_CONTENT (one serve per session)
  const s2 = new Serve(4923, { mcp: { uc: { type: "remote", url: gw.url("sessC"), oauth: false } } });
  await s2.start(); const c2 = new OcClient(s2); await c2.connect();
  const sC = await newSession(c2, "S6c");
  const before3 = gw.calls.length;
  await sC.send("Call the uniqlaw_ping tool exactly once with note 'from-C', then reply with its output."); await sC.idle();
  const callsC = gw.calls.slice(before3).map((c) => c.token);
  c2.close(); await s2.stop();
  const ok = callsA.length > 0 && callsA.every((t) => t === "sessA") && callsC.length > 0 && callsC.every((t) => t === "sessC");
  return { scenario: "S6 MCP", ok,
    notes: `MCP is process/instance-scoped (no per-session MCP in POST /session). (a) runtime POST /mcp added uc_A/uc_B (status keys=${Object.keys(status).join(",")}; tool ids=${ucTools.join(",")}); session ruleset deny uc_B_* → calls=${JSON.stringify(callsA)}; per-message tools:{uc_B_uniqlaw_ping:false} → calls=${JSON.stringify(callsA2)}. (b) OPENCODE_CONFIG_CONTENT per serve → calls=${JSON.stringify(callsC)}` };
});

await run("S7", async () => {
  const s = await newSession(client, "S7");
  await s.send("Reply with exactly: ONE"); await s.idle();
  await s.send("Reply with exactly: TWO", { model: MODEL2 }); await s.idle();
  const models = [...new Set(s.assistantModels)];
  return { scenario: "S7 model switch", ok: models.length === 2,
    notes: `per-message "model" in prompt_async body; assistant models seen: ${models.join(" → ")}` };
});

client.close(); await serve.stop(); gw.stop();
report(OUT, "opencode (opencode serve 1.19.0, HTTP+SSE)", results);
process.exit(0);
