// M0 spike: Antigravity CLI (`agy`) headless print mode, stream-json in/out.
// Run: bun spikes/agy/poc.ts   (from repo root or this dir)
import { spawn, type Subprocess } from "bun";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { Recorder, report, sleep, type ScenarioResult, type AgentEvent } from "../common/index.ts";

const DIR = import.meta.dir;
const WORK = `${DIR}/work`;
const OUT = `${DIR}/out`;
const MODEL = process.env.AGY_MODEL ?? "gemini-3.8-flash-low";
const MODEL2 = process.env.AGY_MODEL2 ?? "gemini-3.8-flash-medium";
mkdirSync(WORK, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Workspace-level MCP config: stdio shim, identity = UNIQLAW_TOKEN inherited from the agy process.
mkdirSync(`${WORK}/.agents`, { recursive: true });
writeFileSync(`${WORK}/.agents/mcp_config.json`, JSON.stringify({
  mcpServers: { uniqlaw: { command: process.execPath, args: [`${DIR}/shim.ts`] } },
}));

/** One agy process = one conversation driven over stdin NDJSON. */
class AgySession {
  proc!: Subprocess<"pipe", "pipe", "pipe">;
  conversationId?: string;
  turn = 0;
  private text = new Map<number, string>();
  private waiters: ((r: any) => void)[] = [];
  results: any[] = [];

  constructor(public rec: Recorder, public opts: { model?: string; resume?: string; settings?: object; env?: Record<string, string> } = {}) {}

  start() {
    const args = ["agy", "--input-format", "stream-json", "--output-format", "stream-json", "--model", this.opts.model ?? MODEL];
    if (this.opts.resume) args.push("--conversation", this.opts.resume);
    if (this.opts.settings) args.push("--settings", JSON.stringify(this.opts.settings));
    args.push("-p="); // prompt comes from stdin
    this.proc = spawn(args, { cwd: WORK, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...this.opts.env } });
    this.pump();
    (async () => { for await (const c of this.proc.stderr) this.rec.write("stderr.log", new TextDecoder().decode(c)); })();
    return this;
  }

  private async pump() {
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let f: any; try { f = JSON.parse(line); } catch { this.rec.write("stdout-nonjson.log", line); continue; }
        if (f.event !== "init") this.rec.raw(f);
        this.map(f);
      }
    }
    for (const w of this.waiters.splice(0)) w({ status: "EOF" });
  }

  /** agy stream-json → AgentEvent */
  private map(f: any) {
    const emit = (e: AgentEvent) => this.rec.emit(e);
    if (f.event === "init") {
      this.conversationId = f.conversation_id;
      emit({ type: "session", providerSessionId: f.conversation_id });
    } else if (f.event === "step_update") {
      const s = f.step_update;
      if (s.step_type === "user_input" && s.state === "DONE") emit({ type: "turn_start", turnId: `${s.conversation_id}#${++this.turn}` });
      else if (s.step_type === "agent_response") {
        if (s.text_delta) {
          this.text.set(s.step_index, (this.text.get(s.step_index) ?? "") + s.text_delta);
          emit({ type: "text", delta: s.text_delta, segmentId: String(s.step_index) });
        }
        if (s.state === "DONE" && this.text.has(s.step_index)) emit({ type: "text", final: this.text.get(s.step_index)!, segmentId: String(s.step_index) });
      } else if (s.step_type === "tool") {
        const id = `${s.conversation_id}:${s.step_index}`;
        if (s.state === "ACTIVE") emit({ type: "tool_start", id, name: s.tool_name, input: s.tool_info?.parameters });
        else emit({ type: "tool_end", id, ok: s.state === "DONE" });
      } else this.rec.write("unmapped.jsonl", f);
    } else if (f.event === "result") {
      const r = f.result;
      this.results.push(r);
      const reason = r.finished_reason === "interrupted" ? "interrupted" : r.status === "SUCCESS" ? "done" : "error";
      // agy has no permission callback: denials are reported after the fact.
      for (const d of r.denied_actions ?? []) emit({ type: "error", error: `permission auto-denied: ${d.action} (${d.display_name})`, fatal: false });
      emit({ type: "turn_end", turnId: `${r.conversation_id}#${this.turn}`, reason, usage: r.usage });
      for (const w of this.waiters.splice(0)) w(r);
    } else this.rec.write("unmapped.jsonl", f);
  }

  send(text: string) {
    this.proc.stdin.write(JSON.stringify({ event: "user", message: { role: "user", content: text } }) + "\n");
    this.proc.stdin.flush();
  }
  nextResult(timeoutMs = 120_000): Promise<any> {
    return Promise.race([new Promise((r) => this.waiters.push(r)), sleep(timeoutMs).then(() => ({ status: "TIMEOUT" }))]);
  }
  async close() { try { this.proc.stdin.end(); } catch {} await Promise.race([this.proc.exited, sleep(5000)]); this.proc.kill(); }
}

const results: ScenarioResult[] = [];
const rec = (name: string) => new Recorder(`${OUT}/${name}`);

// S1 basic
{
  const r = rec("s1"); const s = new AgySession(r).start();
  s.send("Reply with exactly: PONG");
  const res = await s.nextResult();
  const deltas = r.events.filter((e) => e.type === "text" && e.delta).length;
  results.push({ scenario: "S1 basic", ok: res.status === "SUCCESS" && /PONG/.test(res.response) && r.has("session") && r.has("turn_end"),
    notes: `conversation_id=${s.conversationId}; text deltas=${deltas} (token-ish streaming via step_update.text_delta); one persistent process handles many turns` });
  await s.close();
}

// S2 permission: headless cannot prompt → auto-deny; allow-rule via --settings permissions.allow
{
  rmSync(`${WORK}/s2.txt`, { force: true });
  const r = rec("s2-deny"); const s = new AgySession(r).start();
  s.send("Create a file named s2.txt in the current directory containing hello using the shell command: echo hello > s2.txt . Then reply DONE.");
  const res = await s.nextResult(); await s.close();
  const denied = (res.denied_actions ?? []).length > 0 && !existsSync(`${WORK}/s2.txt`);

  const r2 = rec("s2-allow"); const s2 = new AgySession(r2, { settings: { permissions: { allow: ["command(echo hello > s2.txt)"] } } }).start();
  s2.send("Create a file named s2.txt in the current directory containing hello using the shell command: echo hello > s2.txt . Then reply DONE.");
  const res2 = await s2.nextResult(); await s2.close();
  const allowed = existsSync(`${WORK}/s2.txt`);
  results.push({ scenario: "S2 tool + permission", ok: denied && allowed ? true : false,
    notes: `no permission_request/callback in headless (control_request "not supported yet"); default=auto-deny, reported in result.denied_actions (deny worked=${denied}); pre-approval via --settings permissions.allow (exact command string or command(*); prefix/glob like command(echo *) did NOT match) (file created=${allowed}, denied_actions=${JSON.stringify(res2.denied_actions ?? [])})` });
}

// S3 interrupt: no stdin control message → SIGINT the process
{
  const r = rec("s3"); const s = new AgySession(r).start();
  s.send("Write an 800-word essay about the history of tea.");
  const t0 = Date.now();
  while (!r.events.some((e) => e.type === "text") && Date.now() - t0 < 60_000) await sleep(100);
  s.proc.kill("SIGINT");
  const res = await s.nextResult(20_000);
  const conv = s.conversationId!;
  await s.close();
  // continue the same conversation afterwards
  const r2 = rec("s3-continue"); const s2 = new AgySession(r2, { resume: conv }).start();
  s2.send("Reply with exactly: STILL_HERE");
  const res2 = await s2.nextResult(); await s2.close();
  results.push({ scenario: "S3 interrupt", ok: res.finished_reason === "interrupted" && /STILL_HERE/.test(res2.response ?? ""),
    notes: `SIGINT → result.finished_reason=${res.finished_reason ?? "(none)"} status=${res.status}; process exits, so interrupt = kill + respawn with --conversation (continue ok=${/STILL_HERE/.test(res2.response ?? "")})` });
}

// S4 inject: write a second user line while the first turn runs
{
  const r = rec("s4"); const s = new AgySession(r, { settings: { permissions: { allow: ["command(sleep)"] } } }).start();
  s.send("Run the shell command `sleep 3` three times, one at a time, as three separate commands. Then reply FINISHED.");
  const t0 = Date.now();
  while (!r.events.some((e) => e.type === "tool_start") && Date.now() - t0 < 60_000) await sleep(100);
  s.send("Also: end your final reply with the word INJECTED.");
  const a = await s.nextResult(150_000);
  const b = await s.nextResult(60_000);
  await s.close();
  const injectedInFirst = /INJECTED/.test(a.response ?? "");
  results.push({ scenario: "S4 inject", ok: true,
    notes: `turn1 response=${JSON.stringify((a.response ?? "").slice(0, 80))}; turn2=${JSON.stringify((b.response ?? b.status ?? "").slice(0, 80))}; ${injectedInFirst ? "mid-turn message was folded into the running turn (steer-like)" : "second line queued and ran as its own turn after turn1 → inject=queue"}` });
}

// S5 resume
{
  const r = rec("s5a"); const s = new AgySession(r).start();
  s.send("Remember the code word: MANGO42. Reply with exactly: OK");
  await s.nextResult(); const conv = s.conversationId!; await s.close();
  const r2 = rec("s5b"); const s2 = new AgySession(r2, { resume: conv }).start();
  s2.send("What code word did I ask you to remember? Reply with just the word.");
  const res = await s2.nextResult(); await s2.close();
  results.push({ scenario: "S5 resume", ok: /MANGO42/.test(res.response ?? "") && s2.conversationId === conv,
    notes: `--conversation ${conv} → same conversation_id=${s2.conversationId === conv}; response=${JSON.stringify(res.response)}` });
}

// S6 MCP via workspace .agents/mcp_config.json + stdio shim; identity via inherited env
{
  const r = rec("s6"); const token = "agy-sess-" + Math.random().toString(36).slice(2, 8);
  const s = new AgySession(r, { env: { UNIQLAW_TOKEN: token }, settings: { permissions: { allow: ["mcp(uniqlaw/*)"] } } }).start();
  s.send("Call the uniqlaw_ping tool from the uniqlaw MCP server with note 's6' and reply with its exact output.");
  const res = await s.nextResult(); await s.close();
  results.push({ scenario: "S6 MCP", ok: (res.response ?? "").includes(`caller=${token}`),
    notes: `MCP config scopes: global ~/.gemini/config/mcp_config.json, plugins, workspace <cwd>/.agents/mcp_config.json (works). --settings rejects mcpServers; \${ENV} not expanded in serverUrl. Per-session identity achieved with stdio shim reading inherited UNIQLAW_TOKEN → mcp="per-process". Tool invoked via generic call_mcp_tool. response=${JSON.stringify(res.response)}` });
}

// S7 model switch: no live API (control_request unsupported) → respawn with --conversation + --model
{
  const r = rec("s7a"); const s = new AgySession(r).start();
  s.send("Reply with exactly: M1"); await s.nextResult(); const conv = s.conversationId!; await s.close();
  const r2 = rec("s7b"); const s2 = new AgySession(r2, { resume: conv, model: MODEL2 }).start();
  s2.send("What did you reply last time? Reply with just that."); const res = await s2.nextResult(); await s2.close();
  results.push({ scenario: "S7 model switch", ok: /M1/.test(res.response ?? ""),
    notes: `no live switch in stream-json; respawn with --conversation + --model ${MODEL2} keeps history → modelSwitch="spawn"` });
}

report(OUT, `agy ${MODEL}`, results);
process.exit(0);
