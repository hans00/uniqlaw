// M0 spike: real `claude` TUI in tmux → AgentEvent (via jsonl tail + pane polling).
// Run: bun poc.ts [S1 S2 ... X0]
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Recorder, report, startTestGateway, sleep, type ScenarioResult } from "../common/index.ts";
import * as tmux from "./lib/tmux.ts";
import { tailJsonl, type JsonlEvent } from "./lib/jsonl.ts";
import { waitForReady } from "./lib/init-watch.ts";
import { parsePermissionDialog } from "./lib/approval.ts";

const HERE = import.meta.dir;
const WORK = `${HERE}/work`;
const OUT = `${HERE}/out`;
mkdirSync(WORK, { recursive: true });
const MODEL = "haiku";
const jsonlPath = (sid: string, cwd = WORK) => `${homedir()}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${sid}.jsonl`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const BUSY_RE = /esc to interrupt|\(esc\)|Running…|ctrl\+c to interrupt/i;

type Sess = {
  name: string; sid: string; rec: Recorder; texts: string[]; turnEnds: number;
  stop(): Promise<void>; send(text: string): Promise<void>;
  waitTurnEnd(n?: number, timeoutMs?: number): Promise<void>;
  onDialog?: (d: ReturnType<typeof parsePermissionDialog> & {}) => Promise<number | null>;
  pane(): Promise<string>;
};

async function open(name: string, o: { resume?: string; extraArgs?: string[]; cwd?: string } = {}): Promise<Sess> {
  const cwd = o.cwd ?? WORK;
  const rec = new Recorder(`${OUT}/${name}`);
  const target = `uniqlaw-spike-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  await tmux.killSession(target);
  await tmux.newSession(target, { cwd, width: 200, height: 50 });
  const sid = o.resume ?? randomUUID();
  const args = ["claude", o.resume ? "--resume" : "--session-id", sid, "--model", MODEL,
    "--disallowedTools", "ListAgents", "SendMessage", ...(o.extraArgs ?? [])];
  await tmux.sendKeys(target, args.map(shq).join(" "), "Enter");
  const ready = await waitForReady({ target, timeoutMs: 60_000 });
  if (ready.status !== "ready") throw new Error(`${name}: init-watch ${ready.status}: ${ready.pane.slice(-600)}`);
  rec.emit({ type: "session", providerSessionId: sid });

  const s: Sess = {
    name, sid, rec, texts: [], turnEnds: 0,
    pane: () => tmux.capturePane(target),
    async send(text) { await tmux.pasteText(target, text); await sleep(300); await tmux.pressEnter(target); },
    async waitTurnEnd(n = s.turnEnds + 1, timeoutMs = 120_000) {
      const t0 = Date.now();
      while (s.turnEnds < n) { if (Date.now() - t0 > timeoutMs) throw new Error(`${name}: timeout waiting turn_end #${n}`); await sleep(150); }
    },
    async stop() { stopped = true; tail.stop(); await tmux.killSession(target); },
  };

  let turn = 0, inTurn = false, seg = 0, pendingEnd = false, stopped = false;
  const tail = tailJsonl(jsonlPath(sid, cwd), (ev: JsonlEvent) => {
    rec.raw(ev.raw);
    const r = ev.raw;
    if (ev.type === "user-message" && !String(ev.userText).startsWith("<")) {
      if (!inTurn) { inTurn = true; rec.emit({ type: "turn_start", turnId: `t${++turn}` }); }
    } else if (ev.type === "assistant-text") { s.texts.push(ev.text!); rec.emit({ type: "text", final: ev.text!, segmentId: `seg${seg++}` }); }
    else if (ev.type === "assistant-thinking") rec.emit({ type: "thinking", text: ev.text ?? "" });
    else if (ev.type === "assistant-tool-use") rec.emit({ type: "tool_start", id: ev.toolUseId!, name: ev.toolName!, input: ev.toolInput });
    else if (ev.type === "user-tool-result") rec.emit({ type: "tool_end", id: ev.toolUseId!, ok: !ev.toolResultIsError, summary: ev.toolResult?.slice(0, 120) });
    if (ev.type === "turn-end" && !ev.tentative) pendingEnd = true;
    // interrupt marker
    if (ev.type === "user-message" && /\[Request interrupted by user/.test(String(ev.userText))) {
      rec.emit({ type: "turn_end", turnId: `t${turn}`, reason: "interrupted" }); inTurn = false; pendingEnd = false; s.turnEnds++;
    }
    if (r?.type === "system" && r?.subtype === "stop_hook_summary" && inTurn) pendingEnd = true;
  }, { waitForCreateMs: 0 });

  // pane poller: confirms turn end (pane idle) + surfaces permission dialogs
  (async () => {
    let lastFp = "";
    while (!stopped) {
      await sleep(400);
      let pane = ""; try { pane = await tmux.capturePane(target); } catch { break; }
      const d = parsePermissionDialog(pane);
      if (d && d.fingerprint !== lastFp && d.kind !== "survey") {
        lastFp = d.fingerprint;
        rec.emit({ type: "permission_request", id: d.fingerprint, tool: d.kind, input: d.options, title: d.question.split("\n").slice(-3).join(" ").slice(0, 160) });
        const choice = s.onDialog ? await s.onDialog(d) : null;
        if (choice) {
          for (let i = 0; i < choice - 1; i++) { await tmux.sendKeys(target, "Down"); await sleep(60); }
          await tmux.pressEnter(target);
        }
      } else if (d?.kind === "survey") { await tmux.sendKeys(target, "0"); }
      if (!d) lastFp = "";
      if (pendingEnd && !BUSY_RE.test(pane) && !d) {
        pendingEnd = false; inTurn = false; s.turnEnds++;
        rec.emit({ type: "turn_end", turnId: `t${turn}`, reason: "done" });
      }
    }
  })();
  return s;
}

const results: ScenarioResult[] = [];
const want = new Set(process.argv.slice(2));
const run = async (id: string, fn: () => Promise<ScenarioResult>) => {
  if (want.size && !want.has(id)) return;
  console.log(`\n=== ${id}`);
  try { results.push(await fn()); } catch (e) { results.push({ scenario: id, ok: false, notes: String(e).slice(0, 400) }); }
};
const state: Record<string, string> = {};
const S = (p: string) => { try { return JSON.parse(require("node:fs").readFileSync(`${OUT}/state.json`, "utf8"))[p]; } catch { return undefined; } };
const saveState = () => { const prev = (() => { try { return JSON.parse(require("node:fs").readFileSync(`${OUT}/state.json`, "utf8")); } catch { return {}; } })(); writeFileSync(`${OUT}/state.json`, JSON.stringify({ ...prev, ...state }, null, 2)); };

await run("S1", async () => {
  const s = await open("S1");
  s.send("Reply with exactly: PONG");
  await s.waitTurnEnd();
  s.send("Do you currently have tools named ListAgents or SendMessage available? Answer exactly NONE if neither, otherwise list the ones you have.");
  await s.waitTurnEnd();
  await s.stop();
  state.s1 = s.sid; saveState();
  // flag check via the same CLI in print mode: does --disallowedTools remove them from the tool list?
  const p = Bun.spawnSync(["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", MODEL, "--max-turns", "1",
    "--disallowedTools", "ListAgents", "SendMessage", "Reply OK"], { cwd: WORK });
  const init = p.stdout.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.subtype === "init");
  const listed = ["ListAgents", "SendMessage"].filter((t) => init?.tools?.includes(t));
  return { scenario: "S1 basic", ok: s.texts.join(" ").includes("PONG"),
    notes: `sid=${s.sid} (we choose it: --session-id); segment granularity (jsonl flush per block); model self-report on ListAgents/SendMessage: "${s.texts.at(-1)?.slice(0, 60)}"; CLI init with --disallowedTools lists: [${listed}]` };
});

await run("S2", async () => {
  const s = await open("S2", { extraArgs: ["--permission-mode", "default"] });
  const f1 = `${WORK}/s2.txt`, f2 = `${WORK}/s2-deny.txt`; rmSync(f1, { force: true }); rmSync(f2, { force: true });
  let mode: "allow" | "deny" = "allow"; const seen: string[] = [];
  s.onDialog = async (d) => {
    seen.push(`${d.kind}:${d.options.join("/")}`);
    if (mode === "allow") return 1;
    const no = d.options.findIndex((o) => /^No\b/i.test(o));
    return no >= 0 ? no + 1 : d.options.length;
  };
  s.send(`Use the Bash tool to run: touch ${f1}   Then reply DONE.`);
  await s.waitTurnEnd();
  const allowOk = existsSync(f1);
  mode = "deny";
  s.send(`Use the Bash tool to run: touch ${f2}   Then reply DONE.`);
  await s.waitTurnEnd(undefined, 90_000).catch(() => {});
  const denyOk = !existsSync(f2);
  writeFileSync(`${OUT}/S2/pane-end.txt`, await s.pane());
  await s.stop();
  return { scenario: "S2 tool+permission (pane dialog)", ok: allowOk && denyOk && seen.length >= 2,
    notes: `dialogs seen=${JSON.stringify(seen)}; allow→created=${allowOk}; deny→absent=${denyOk}` };
});

await run("S3", async () => {
  const s = await open("S3");
  s.send("Write an 800-word essay about the history of tea. No tools.");
  const t0 = Date.now();
  while (!BUSY_RE.test(await s.pane()) && Date.now() - t0 < 20_000) await sleep(200);
  await sleep(2500);
  await tmux.pressEscape(`uniqlaw-spike-s3`);
  const tEsc = Date.now();
  await s.waitTurnEnd(undefined, 30_000).catch(() => {});
  const end = s.rec.events.filter((e) => e.type === "turn_end").at(-1);
  await sleep(1000);
  s.send("Reply with exactly: STILL_HERE");
  await s.waitTurnEnd(undefined, 60_000).catch(() => {});
  await s.stop();
  return { scenario: "S3 interrupt (Esc)", ok: s.texts.join(" ").includes("STILL_HERE"),
    notes: `turn_end after Esc=${JSON.stringify(end)} (${end ? "detected" : "NOT detected"} within 30s of Esc at +${tEsc - t0}ms); continues=${s.texts.join(" ").includes("STILL_HERE")}` };
});

await run("S4", async () => {
  const s = await open("S4", { extraArgs: ["--dangerously-skip-permissions"] });
  s.send("Use the Bash tool three separate times, one call per message, sequentially: `sleep 3 && echo A`, then `sleep 3 && echo B`, then `sleep 3 && echo C`. After all three, reply with the letters you saw.");
  const t0 = Date.now();
  while (!s.rec.has("tool_start") && Date.now() - t0 < 60_000) await sleep(100);
  writeFileSync(`${OUT}/S4/pane-busy.txt`, await s.pane());
  s.send("Also: end your final reply with the word INJECTED.");
  await s.waitTurnEnd(undefined, 120_000);
  await s.waitTurnEnd(2, 30_000).catch(() => {});
  await s.stop();
  const raw = (await Bun.file(jsonlPath(s.sid)).text());
  const asAttachment = /"queued_command"[^\n]*INJECTED/.test(raw);
  let tools = 0; for (const e of s.rec.events) { if (e.type === "turn_end") break; if (e.type === "tool_start") tools++; }
  return { scenario: "S4 inject (type while busy)", ok: true,
    notes: `turn_ends=${s.turnEnds}; tools before 1st end=${tools}; delivered as queued_command attachment (mid-turn)=${asAttachment}; final text has INJECTED=${s.texts.join(" ").includes("INJECTED")}` };
});

await run("S5", async () => {
  const sid = S("s1");
  if (!sid) return { scenario: "S5 resume", ok: false, notes: "run S1 first" };
  const s = await open("S5", { resume: sid });
  s.send("What exact word did I ask you to reply with first? Answer with just that word.");
  await s.waitTurnEnd(); await s.stop();
  return { scenario: "S5 resume (--resume)", ok: s.texts.join(" ").includes("PONG"), notes: `answer=${s.texts.at(-1)?.slice(0, 60)}` };
});

await run("S6", async () => {
  const gw = startTestGateway();
  const key = "claude-tmux-S6";
  const cfg = `${OUT}/S6-mcp.json`; mkdirSync(OUT, { recursive: true });
  writeFileSync(cfg, JSON.stringify({ mcpServers: { uniqlaw: { type: "http", url: gw.url(key) } } }));
  const s = await open("S6", { extraArgs: ["--mcp-config", cfg, "--allowedTools", "mcp__uniqlaw__uniqlaw_ping"] });
  s.send("Call the uniqlaw_ping tool with note 'hello', then reply with its output verbatim.");
  s.onDialog = async () => 1;
  await s.waitTurnEnd(); await s.stop(); gw.stop();
  return { scenario: "S6 MCP (--mcp-config)", ok: gw.calls.some((c) => c.token === key), notes: `gateway calls=${JSON.stringify(gw.calls.map((c) => c.token))}; per-session via CLI flag` };
});

await run("S7", async () => {
  const s = await open("S7");
  s.send("Reply with exactly: ONE"); await s.waitTurnEnd();
  s.onDialog = async (d) => { s.rec.write("dialogs.jsonl", d); return 1; };
  await tmux.pasteText("uniqlaw-spike-s7", "/model sonnet"); await sleep(400); await tmux.pressEnter("uniqlaw-spike-s7");
  await sleep(3000);
  s.send("Reply with exactly: TWO"); await s.waitTurnEnd(); await s.stop();
  const models = (await Bun.file(jsonlPath(s.sid)).text()).trim().split("\n").map((l) => JSON.parse(l)).filter((o) => o.type === "assistant").map((o) => o.message.model);
  return { scenario: "S7 model switch (/model)", ok: new Set(models).size > 1, notes: `models on assistant entries: ${[...new Set(models)]}` };
});

// ---- (0) session interop ----------------------------------------------------
async function sdkAsk(sid: string, prompt: string, cwd = WORK) {
  const q = query({ prompt, options: { cwd, model: MODEL, resume: sid, settingSources: ["user", "project", "local"], disallowedTools: ["ListAgents", "SendMessage"] } as any });
  let text = "", newSid = "";
  for await (const m of q as any) { if (m.type === "system" && m.subtype === "init") newSid = m.session_id; if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") text += b.text; }
  return { text, newSid };
}

await run("X0a", async () => {
  // tmux creates → SDK resumes
  const s = await open("X0a");
  s.send("Remember the codeword TANGERINE-42. Reply with exactly: NOTED"); await s.waitTurnEnd(); await s.stop();
  const r = await sdkAsk(s.sid, "What codeword did I ask you to remember? Answer with just the codeword.");
  return { scenario: "X0a tmux→SDK resume", ok: r.text.includes("TANGERINE-42"), notes: `sid=${s.sid}; sdk session_id after resume=${r.newSid} (same=${r.newSid === s.sid}); answer=${r.text.slice(0, 60)}` };
});

await run("X0b", async () => {
  // SDK creates → tmux resumes
  const q = query({ prompt: "Remember the codeword MANGO-77. Reply with exactly: NOTED", options: { cwd: WORK, model: MODEL, settingSources: ["user", "project", "local"] } as any });
  let sid = ""; for await (const m of q as any) if (m.type === "system" && m.subtype === "init") sid = m.session_id;
  await sleep(500);
  const s = await open("X0b", { resume: sid });
  s.send("What codeword did I ask you to remember? Answer with just the codeword."); await s.waitTurnEnd(); await s.stop();
  return { scenario: "X0b SDK→tmux resume", ok: s.texts.join(" ").includes("MANGO-77"), notes: `sid=${sid}; answer=${s.texts.at(-1)?.slice(0, 60)}` };
});

await run("X0c", async () => {
  // gotcha: resume from a different cwd
  const sid = S("s1");
  const other = `${HERE}/work-other`; mkdirSync(other, { recursive: true });
  const r = await sdkAsk(sid, "What exact word did I ask you to reply with first? Just the word.", other).catch((e) => ({ text: `ERR ${e}`, newSid: "" }));
  return { scenario: "X0c resume from different cwd", ok: "n/a", notes: `resume ${sid} with cwd=work-other → answer="${r.text.slice(0, 100)}" newSid=${r.newSid}` };
});

{ const fs = require("node:fs"); const pth = `${OUT}/results.json`; const prev: ScenarioResult[] = fs.existsSync(pth) ? JSON.parse(fs.readFileSync(pth, "utf8")) : []; const merged = [...prev.filter((p) => !results.some((r) => r.scenario === p.scenario)), ...results].sort((a, b) => a.scenario.localeCompare(b.scenario)); fs.writeFileSync(pth, JSON.stringify(merged, null, 2)); report(OUT, "claude-tmux", merged); }
for (const t of await tmux.listSessions()) if (t.startsWith("uniqlaw-spike-")) await tmux.killSession(t);
process.exit(0);
