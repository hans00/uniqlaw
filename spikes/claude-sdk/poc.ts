// M0 spike: Claude Agent SDK → AgentEvent. Run: bun poc.ts [S1 S2 ...]
import { query, type SDKMessage, type SDKUserMessage, type Query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { Recorder, report, startTestGateway, sleep, type ScenarioResult } from "../common/index.ts";

const HERE = import.meta.dir;
const WORK = `${HERE}/work`;
const OUT = `${HERE}/out`;
mkdirSync(WORK, { recursive: true });
const MODEL = "haiku";
const DISALLOW = ["ListAgents", "SendMessage"];

/** Async-iterable input queue for streaming-input mode. */
class Input implements AsyncIterable<SDKUserMessage> {
  private q: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(text: string, priority?: "now" | "next" | "later") {
    this.q.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(priority ? { priority } : {}) } as SDKUserMessage);
    this.wake?.();
  }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.q.length) yield this.q.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

type Sess = {
  q: Query; input: Input; rec: Recorder; sessionId?: string; init?: any;
  turnEnds: number; waitTurnEnd(n?: number, timeoutMs?: number): Promise<void>; texts: string[];
};

function open(name: string, opts: Record<string, unknown> = {}, canUseTool?: CanUseTool): Sess {
  const rec = new Recorder(`${OUT}/${name}`);
  const input = new Input();
  const q = query({
    prompt: input,
    options: {
      cwd: WORK, model: MODEL, disallowedTools: DISALLOW, includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      ...(canUseTool ? { canUseTool } : {}),
      ...opts,
    } as any,
  });
  const s: Sess = {
    q, input, rec, turnEnds: 0, texts: [],
    async waitTurnEnd(n = s.turnEnds + 1, timeoutMs = 120_000) {
      const t0 = Date.now();
      while (s.turnEnds < n) { if (Date.now() - t0 > timeoutMs) throw new Error(`${name}: timeout waiting turn_end #${n}`); await sleep(100); }
    },
  };
  let turn = 0, inTurn = false, seg = 0;
  (async () => {
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        rec.raw(m);
        const mm = m as any;
        if (mm.type === "system" && mm.subtype === "init") {
          s.init = mm; s.sessionId = mm.session_id;
          rec.emit({ type: "session", providerSessionId: mm.session_id });
        }
        if (!inTurn && (mm.type === "assistant" || mm.type === "stream_event")) {
          inTurn = true; rec.emit({ type: "turn_start", turnId: `t${++turn}` });
        }
        if (mm.type === "stream_event") {
          const ev = mm.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta")
            rec.events.push({ type: "text", delta: ev.delta.text, segmentId: `seg${seg}` }); // deltas: count only, not printed
        } else if (mm.type === "assistant") {
          for (const b of mm.message.content ?? []) {
            if (b.type === "text") { s.texts.push(b.text); rec.emit({ type: "text", final: b.text, segmentId: `seg${seg++}` }); }
            else if (b.type === "thinking") rec.emit({ type: "thinking", text: b.thinking ?? "" });
            else if (b.type === "tool_use") rec.emit({ type: "tool_start", id: b.id, name: b.name, input: b.input });
          }
        } else if (mm.type === "user" && Array.isArray(mm.message?.content)) {
          for (const b of mm.message.content)
            if (b.type === "tool_result") rec.emit({ type: "tool_end", id: b.tool_use_id, ok: !b.is_error, summary: String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 120) });
        } else if (mm.type === "result") {
          const interrupted = mm.terminal_reason && /interrupt|abort/i.test(String(mm.terminal_reason));
          rec.emit({ type: "turn_end", turnId: `t${turn}`, reason: mm.subtype === "success" && !interrupted ? "done" : interrupted ? "interrupted" : "error", usage: { terminal_reason: mm.terminal_reason, subtype: mm.subtype, stop_reason: mm.stop_reason } });
          inTurn = false; s.turnEnds++;
        }
      }
    } catch (e) { rec.emit({ type: "error", error: String(e), fatal: true }); s.turnEnds = 1e9; }
  })();
  return s;
}
const deltas = (s: Sess) => s.rec.events.filter((e) => e.type === "text" && e.delta).length;
const close = (s: Sess) => { s.input.close(); s.q.close?.(); };

const results: ScenarioResult[] = [];
const want = new Set(process.argv.slice(2));
const run = async (id: string, fn: () => Promise<ScenarioResult>) => {
  if (want.size && !want.has(id)) return;
  console.log(`\n=== ${id}`);
  try { results.push(await fn()); } catch (e) { results.push({ scenario: id, ok: false, notes: String(e) }); }
};
let s1Session: string | undefined;

await run("S1", async () => {
  const s = open("S1");
  s.input.push("Reply with exactly: PONG");
  await s.waitTurnEnd();
  s1Session = s.sessionId;
  const init = s.init;
  writeFileSync(`${OUT}/init.json`, JSON.stringify(init, null, 2));
  const initRes = await s.q.initializationResult().catch((e: any) => ({ error: String(e) }));
  writeFileSync(`${OUT}/initializationResult.json`, JSON.stringify(initRes, null, 2));
  const listed = DISALLOW.filter((t) => init.tools.includes(t));
  close(s);
  return { scenario: "S1 basic", ok: s.texts.join("").includes("PONG") && !!s.sessionId,
    notes: `session=${s.sessionId}; text deltas=${deltas(s)} (token streaming via stream_event); apiKeySource=${init.apiKeySource}; tools=${init.tools.length}, skills=${init.skills.length}, plugins=${init.plugins.length}, slash=${init.slash_commands.length}, mcp=${init.mcp_servers.length}; disallowed still listed: [${listed}]` };
});

await run("S1b", async () => {
  // control: without disallowedTools, are ListAgents/SendMessage present at all?
  const s = open("S1b", { disallowedTools: [] });
  s.input.push("Reply with exactly: OK");
  await s.waitTurnEnd(); close(s);
  const present = DISALLOW.filter((t) => s.init.tools.includes(t));
  writeFileSync(`${OUT}/init-no-disallow.tools.json`, JSON.stringify(s.init.tools));
  return { scenario: "S1b disallow control", ok: true, notes: `without disallowedTools, present: [${present}] (of ${s.init.tools.length} tools)` };
});

await run("S2", async () => {
  const f = `${WORK}/s2.txt`; if (existsSync(f)) rmSync(f);
  let decision: "allow" | "deny" = "allow"; const asked: string[] = [];
  const canUse: CanUseTool = async (tool, input, o) => {
    asked.push(tool);
    s.rec.emit({ type: "permission_request", id: (o as any).toolUseID ?? "?", tool, input, title: (o as any).title ?? tool });
    return decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "denied by operator (spike)" };
  };
  const s = open("S2", { permissionMode: "default" }, canUse);
  s.input.push(`Use the Bash tool to run: touch ${f}   Then reply DONE.`);
  await s.waitTurnEnd();
  const allowedOk = existsSync(f);
  rmSync(f, { force: true });
  decision = "deny";
  s.input.push(`Use the Bash tool to run: touch ${WORK}/s2-deny.txt   Then reply DONE.`);
  await s.waitTurnEnd(); close(s);
  const denyOk = !existsSync(`${WORK}/s2-deny.txt`);
  return { scenario: "S2 tool+permission", ok: allowedOk && denyOk && asked.length >= 2,
    notes: `canUseTool asked for [${asked}]; allow→file created=${allowedOk}; deny→file absent=${denyOk}` };
});

await run("S3", async () => {
  const s = open("S3");
  s.input.push("Write an 800-word essay about the history of tea. No tools.");
  const t0 = Date.now();
  while (deltas(s) < 5 && Date.now() - t0 < 60_000) await sleep(50);
  const r = await s.q.interrupt();
  await s.waitTurnEnd();
  const end = s.rec.events.filter((e) => e.type === "turn_end").at(-1) as any;
  s.input.push("Reply with exactly: STILL_HERE");
  await s.waitTurnEnd(); close(s);
  return { scenario: "S3 interrupt", ok: s.texts.join("").includes("STILL_HERE"),
    notes: `interrupt() → ${JSON.stringify(r)}; first turn_end=${JSON.stringify(end)}; session continues=${s.texts.join("").includes("STILL_HERE")}` };
});

for (const prio of ["next", "later", "now", undefined] as const) {
  await run(`S4-${prio ?? "default"}`, async () => {
    const s = open(`S4-${prio ?? "default"}`, { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
    s.input.push("Use the Bash tool three separate times, one call per message, sequentially: `sleep 3 && echo A`, then `sleep 3 && echo B`, then `sleep 3 && echo C`. After all three, reply with the letters you saw.");
    const t0 = Date.now();
    while (!s.rec.has("tool_start") && Date.now() - t0 < 60_000) await sleep(50);
    s.rec.write("events.jsonl", { t: Date.now(), marker: "INJECT_SENT", priority: prio });
    s.input.push("Also: end your final reply with the word INJECTED.", prio);
    await s.waitTurnEnd();
    // a queued message may produce a second turn
    await s.waitTurnEnd(2, 60_000).catch(() => {});
    close(s);
    const toolsBeforeFirstEnd: string[] = [];
    for (const e of s.rec.events) { if (e.type === "turn_end") break; if (e.type === "tool_start") toolsBeforeFirstEnd.push(String((e.input as any)?.command ?? "")); }
    const firstTurnTexts: string[] = []; let seenEnd = 0;
    for (const e of s.rec.events) { if (e.type === "turn_end") seenEnd++; if (e.type === "text" && e.final && seenEnd === 0) firstTurnTexts.push(e.final); }
    return { scenario: `S4 inject priority=${prio ?? "(unset)"}`, ok: true,
      notes: `turn_ends=${s.turnEnds}; tools in 1st turn=${toolsBeforeFirstEnd.length}; INJECTED in 1st turn=${firstTurnTexts.join(" ").includes("INJECTED")}; INJECTED anywhere=${s.texts.join(" ").includes("INJECTED")}; turn_end reasons=${s.rec.events.filter((e) => e.type === "turn_end").map((e: any) => e.reason)}` };
  });
}

await run("S5", async () => {
  let sid = s1Session;
  if (!sid) { const s0 = open("S5-pre"); s0.input.push("Reply with exactly: PONG"); await s0.waitTurnEnd(); sid = s0.sessionId; close(s0); }
  await sleep(500);
  const s = open("S5", { resume: sid });
  s.input.push("What exact word did I ask you to reply with earlier? Answer with just that word.");
  await s.waitTurnEnd(); close(s);
  return { scenario: "S5 resume", ok: s.texts.join("").includes("PONG"), notes: `resume=${sid} → new session_id=${s.sessionId} (same=${s.sessionId === sid}); answer=${s.texts.join(" ").slice(0, 80)}` };
});

await run("S6", async () => {
  const gw = startTestGateway();
  const key = "claude-sdk-S6";
  const s = open("S6", { mcpServers: { uniqlaw: { type: "http", url: gw.url(key) } }, allowedTools: ["mcp__uniqlaw__uniqlaw_ping"] });
  s.input.push("Call the uniqlaw_ping tool with note 'hello', then reply with its output verbatim.");
  await s.waitTurnEnd(); close(s); gw.stop();
  const st = s.init.mcp_servers;
  return { scenario: "S6 MCP", ok: gw.calls.some((c) => c.token === key), notes: `mcp_servers=${JSON.stringify(st)}; gateway calls=${JSON.stringify(gw.calls.map((c) => c.token))}; per-session (query option)` };
});

await run("S7", async () => {
  const s = open("S7");
  s.input.push("Reply with exactly: ONE"); await s.waitTurnEnd();
  const m1 = s.rec.events;
  await s.q.setModel("sonnet");
  s.input.push("Reply with exactly: TWO"); await s.waitTurnEnd(); close(s);
  const raws = (await Bun.file(`${OUT}/S7/raw.jsonl`).text()).trim().split("\n").map((l) => JSON.parse(l).frame).filter((f: any) => f.type === "assistant").map((f: any) => f.message.model);
  return { scenario: "S7 model switch", ok: new Set(raws).size > 1, notes: `setModel live; models seen on assistant msgs: ${[...new Set(raws)]}` };
});

{ const fs = require("node:fs"); const pth = `${OUT}/results.json`; const prev: ScenarioResult[] = fs.existsSync(pth) ? JSON.parse(fs.readFileSync(pth, "utf8")) : []; const merged = [...prev.filter((p) => !results.some((r) => r.scenario === p.scenario)), ...results].sort((a, b) => a.scenario.localeCompare(b.scenario)); fs.writeFileSync(pth, JSON.stringify(merged, null, 2)); report(OUT, "claude-sdk", merged); }
process.exit(0);
