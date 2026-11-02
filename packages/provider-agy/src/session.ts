// One UniQlaw session = one agy conversation, driven by an `agy -p= --input-format stream-json`
// process. The process is respawned with `--conversation <id>` after interrupts (SIGINT ends it)
// and model switches (no live switch over stdin).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import { join } from "node:path";
import type { AgentEvent, AgentSession, Logger, TurnInput, Usage } from "@uniqlaw/core";
import { AGY_CAPABILITIES, MCP_SERVER_NAME, deniedNote, errorCodeFromStderr, type DeniedAction } from "./mapping.ts";

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = []; private wake?: () => void; private ended = false;
  push(x: T) { if (this.ended) return; this.items.push(x); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

export interface AgySessionOptions {
  agyPath: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: string;
  conversationId?: string;
  /** Per-session workspace dir holding .agents/mcp_config.json (passed via --add-dir). */
  workspaceDir: string;
  mcp?: { url: string; token: string; shimCommand: string[] };
  settings: object;
  flags: string[];
  extraArgs: string[];
  log: Logger;
}

type Proc = Subprocess<"pipe", "pipe", "pipe">;

export class AgySession implements AgentSession {
  readonly capabilities = AGY_CAPABILITIES;
  readonly events: AsyncIterable<AgentEvent>;
  private q = new Queue<AgentEvent>();
  private proc?: Proc;
  private conversationId?: string;
  private announced?: string;
  private model?: string;
  private running = false;
  private interrupting = false;
  private restartAfterTurn = false;
  private turnSeq = 0;
  private texts = new Map<number, string>();
  private lastStderrError?: string;
  private closed = false;
  private interruptTimer?: ReturnType<typeof setTimeout>;

  constructor(private o: AgySessionOptions) {
    this.events = this.q;
    this.conversationId = o.conversationId;
    this.model = o.model;
    this.prepareWorkspace();
    if (this.conversationId) this.announce(this.conversationId);
  }

  /** Spawn eagerly: agy prints `init` (conversation id) before any input. */
  start() { this.ensureProc(); return this; }

  // ── AgentSession ──────────────────────────────────────────────────────────

  async send(input: TurnInput): Promise<void> {
    if (this.closed) throw new Error("session closed");
    const p = this.ensureProc();
    this.running = true;
    this.texts.clear();
    this.lastStderrError = undefined;
    this.turnSeq++;
    this.q.push({ type: "turn_start", turnId: this.turnId() });
    const content = input.attachments.length
      ? `${input.text}\n\n${input.attachments.map((a) => `[Attached ${a.kind}: ${a.path}]`).join("\n")}`
      : input.text;
    p.stdin.write(JSON.stringify({ event: "user", message: { role: "user", content } }) + "\n");
    p.stdin.flush();
  }

  async interrupt(): Promise<void> {
    if (!this.running || !this.proc) return;
    this.interrupting = true;
    this.proc.kill("SIGINT");
    // agy normally answers with result{finished_reason:"interrupted"} and exits.
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      if (!this.interrupting) return;
      this.o.log.warn("agy did not exit after SIGINT; killing");
      this.proc?.kill("SIGKILL");
      this.finishTurn("interrupted");
    }, 10_000);
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    this.q.push({ type: "model", model });
    if (this.running) this.restartAfterTurn = true;
    else await this.stopProc();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.interruptTimer);
    await this.stopProc();
    try { rmSync(this.o.workspaceDir, { recursive: true, force: true }); } catch {}
    this.q.end();
  }

  async alive(): Promise<boolean> { return !this.closed; }

  // ── process ───────────────────────────────────────────────────────────────

  private turnId() { return `t${this.turnSeq}`; }

  private prepareWorkspace() {
    mkdirSync(join(this.o.workspaceDir, ".agents"), { recursive: true });
    const servers = this.o.mcp
      ? { [MCP_SERVER_NAME]: { command: this.o.mcp.shimCommand[0], args: this.o.mcp.shimCommand.slice(1) } }
      : {};
    writeFileSync(join(this.o.workspaceDir, ".agents", "mcp_config.json"), JSON.stringify({ mcpServers: servers }, null, 2));
  }

  args(): string[] {
    const a = [this.o.agyPath, "--input-format", "stream-json", "--output-format", "stream-json"];
    if (this.model) a.push("--model", this.model);
    if (this.o.effort) a.push("--effort", this.o.effort);
    if (this.conversationId) a.push("--conversation", this.conversationId);
    a.push("--add-dir", this.o.workspaceDir, "--settings", JSON.stringify(this.o.settings), ...this.o.flags, ...this.o.extraArgs);
    a.push("-p="); // `-p=` (empty) — a bare `-p` would swallow the next flag as the prompt
    return a;
  }

  private ensureProc(): Proc {
    if (this.proc) return this.proc;
    // agy needs PATH (helpers) and HOME (config, keyring session); take them from the daemon
    // only when the spec didn't provide them — nothing else from the daemon env leaks in.
    const env: Record<string, string> = { ...this.o.env };
    for (const k of ["PATH", "HOME"]) if (!env[k] && process.env[k]) env[k] = process.env[k]!;
    if (this.o.mcp) { env.UNIQLAW_MCP_URL = this.o.mcp.url; env.UNIQLAW_TOKEN = this.o.mcp.token; }
    const argv = this.args();
    argv[0] = Bun.which(argv[0]!, { PATH: env.PATH }) ?? argv[0]!;
    const p = Bun.spawn(argv, { cwd: this.o.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = p;
    this.o.log.debug("agy spawned", { pid: p.pid, conversation: this.conversationId, model: this.model });
    void this.readStdout(p);
    void this.readStderr(p);
    void p.exited.then((code) => this.onExit(p, code));
    return p;
  }

  private async stopProc() {
    const p = this.proc;
    if (!p) return;
    this.proc = undefined;
    try { p.stdin.end(); } catch {}
    const t = setTimeout(() => p.kill("SIGKILL"), 3000);
    await p.exited.catch(() => {});
    clearTimeout(t);
  }

  private onExit(p: Proc, code: number) {
    if (this.proc !== p) return; // already replaced (interrupt / model switch / close)
    this.proc = undefined;
    if (this.closed) return;
    this.o.log.debug("agy exited", { code, running: this.running, interrupting: this.interrupting });
    if (this.running) this.finishTurn(this.interrupting ? "interrupted" : "error", this.interrupting ? undefined : (this.lastStderrError ?? `agy exited (code ${code})`));
  }

  private async readStdout(p: Proc) {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let f: Record<string, any>;
        try { f = JSON.parse(line); } catch { this.o.log.debug("agy non-json stdout", { line: line.slice(0, 200) }); continue; }
        try { this.onFrame(f); } catch (e) { this.o.log.warn("frame handling failed", { e: String(e) }); }
      }
    }
  }

  private async readStderr(p: Proc) {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stderr) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const code = errorCodeFromStderr(line);
        if (code) this.lastStderrError = code;
        if (line.trim()) this.o.log.debug("agy stderr", { line: line.slice(0, 300) });
      }
    }
  }

  private announce(id: string) {
    if (this.announced === id) return;
    this.announced = id;
    this.q.push({ type: "session", providerSessionId: id });
  }

  onFrame(f: Record<string, any>) {
    if (f.event === "init") {
      if (f.conversation_id) { this.conversationId = f.conversation_id; this.announce(f.conversation_id); }
      return;
    }
    if (f.event === "step_update") {
      const s = f.step_update ?? {};
      if (s.step_type === "agent_response") {
        const idx = Number(s.step_index ?? 0);
        if (s.text_delta) {
          this.texts.set(idx, (this.texts.get(idx) ?? "") + s.text_delta);
          this.q.push({ type: "text", segmentId: `${this.turnId()}:${idx}`, delta: s.text_delta });
        }
        if (s.state === "DONE" && this.texts.has(idx)) {
          this.q.push({ type: "text", segmentId: `${this.turnId()}:${idx}`, final: this.texts.get(idx)!.replace(/\s+$/, "") });
          this.texts.delete(idx);
        }
      } else if (s.step_type === "tool") {
        const id = `${s.conversation_id ?? this.conversationId}:${s.step_index}`;
        const name = s.tool_name === "call_mcp_tool" && s.tool_info?.parameters?.ToolName
          ? `mcp__${s.tool_info.parameters.ServerName ?? "?"}__${s.tool_info.parameters.ToolName}` : (s.tool_name ?? "tool");
        if (s.state === "ACTIVE") this.q.push({ type: "tool_start", id, name, input: s.tool_info?.parameters });
        else if (s.state === "DONE" || s.state === "ERROR" || s.state === "CANCELED") this.q.push({ type: "tool_end", id, ok: s.state === "DONE" });
      }
      return;
    }
    if (f.event === "result") {
      const r = f.result ?? {};
      if (r.conversation_id) { this.conversationId = r.conversation_id; this.announce(r.conversation_id); }
      // Flush any agent text that never got a DONE step.
      for (const [idx, t] of this.texts) if (t.trim()) this.q.push({ type: "text", segmentId: `${this.turnId()}:${idx}`, final: t.replace(/\s+$/, "") });
      this.texts.clear();
      const denied = (r.denied_actions ?? []) as DeniedAction[];
      denied.forEach((d, i) => this.q.push({ type: "tool_end", id: `denied:${this.turnId()}:${i}`, ok: false, summary: `blocked by policy: ${d.display_name ?? d.action}` }));
      if (denied.length) this.q.push({ type: "text", segmentId: `${this.turnId()}:denied`, final: deniedNote(denied) });
      const reason = r.finished_reason === "interrupted" || this.interrupting ? "interrupted"
        : r.status === "SUCCESS" && !r.finished_reason ? "done" : "error";
      const u = r.usage ?? {};
      const usage: Usage = { inputTokens: u.input_tokens, outputTokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) };
      this.finishTurn(reason, reason === "error" ? (this.lastStderrError ?? r.error ?? r.finished_reason ?? "agy turn failed") : undefined, usage);
    }
  }

  private finishTurn(reason: "done" | "interrupted" | "error", error?: string, usage?: Usage) {
    if (!this.running) return;
    clearTimeout(this.interruptTimer);
    // SIGINT makes agy exit after reporting the interrupted result: forget the dying process so
    // the next send() respawns with --conversation instead of writing into it.
    if (reason === "interrupted" && this.proc) { const dying = this.proc; this.proc = undefined; setTimeout(() => dying.kill("SIGKILL"), 5000).unref?.(); }
    this.running = false;
    this.interrupting = false;
    this.q.push({ type: "turn_end", turnId: this.turnId(), reason, ...(usage ? { usage } : {}), ...(error ? { error } : {}) });
    if (this.restartAfterTurn) { this.restartAfterTurn = false; void this.stopProc(); }
  }
}
