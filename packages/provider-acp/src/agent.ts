// One ACP agent subprocess (stdio JSON-RPC). Hosts one session by default, several
// when shareProcess is enabled; routes session/update and agent→client requests.
import * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "@uniqlaw/core";

export interface SessionSink {
  onUpdate(update: any): void;
  onPermission(params: any): Promise<unknown>;
  onElicitation(params: any): Promise<unknown>;
}

export class AcpAgent {
  proc?: ReturnType<typeof Bun.spawn>;
  init: any;
  readonly sinks = new Map<string, SessionSink>();
  private conn?: acp.ClientConnection;
  private stderrTail = "";
  private exitHandlers = new Set<(code: number | null) => void>();
  private stderrLineHandlers = new Set<(line: string) => void>();
  private stderrPartial = "";
  stopping = false;

  constructor(private o: { command: string[]; cwd: string; env: Record<string, string>; log: Logger; clientName: string }) {}

  async start(timeoutMs: number): Promise<any> {
    const { command, cwd, env, log } = this.o;
    this.proc = Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void (async () => {
      const dec = new TextDecoder();
      for await (const c of this.proc!.stderr as unknown as AsyncIterable<Uint8Array>) {
        const s = dec.decode(c);
        this.stderrTail = (this.stderrTail + s).slice(-4000);
        const lines = (this.stderrPartial + s).split("\n");
        this.stderrPartial = lines.pop() ?? "";
        for (const l of lines) for (const h of this.stderrLineHandlers) { try { h(l); } catch {} }
      }
    })();
    void this.proc.exited.then((code) => {
      if (!this.stopping) log.warn("acp agent exited", { code, stderr: this.stderrTail.slice(-500) });
      for (const h of this.exitHandlers) h(code);
    });
    const stdin = this.proc.stdin as unknown as { write(c: Uint8Array): void; flush?(): void };
    const output = new WritableStream<Uint8Array>({ write(chunk) { stdin.write(chunk); stdin.flush?.(); } });
    const stream = acp.ndJsonStream(output, this.proc.stdout as ReadableStream<Uint8Array>);
    const sinkFor = (params: any) => this.sinks.get(params?.sessionId);
    const app = (acp.client({ name: this.o.clientName }) as any)
      .onNotification("session/update", ({ params }: any) => sinkFor(params)?.onUpdate(params.update))
      .onNotification("*", ({ method }: any) => log.debug("unhandled acp notification", { method }))
      .onRequest("session/request_permission", async ({ params }: any) => {
        const s = sinkFor(params);
        return s ? s.onPermission(params) : { outcome: { outcome: "cancelled" } };
      })
      .onRequest("elicitation/create", async ({ params }: any) => {
        const s = sinkFor(params) ?? [...this.sinks.values()][0];
        return s ? s.onElicitation(params) : { action: "cancel" };
      })
      .onRequest("*", async ({ method }: any) => { throw new Error(`unsupported client method ${method}`); });
    this.conn = app.connect(stream);
    this.init = await Promise.race([
      this.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        // The agent uses its own fs/terminal tools; UniQlaw only brokers approvals + elicitation.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: this.o.clientName, version: "0.1.0" },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`acp initialize timed out: ${this.stderrTail.slice(-300)}`)), timeoutMs)),
      this.proc.exited.then((c) => { throw new Error(`acp agent exited during initialize (${c}): ${this.stderrTail.slice(-300)}`); }),
    ]);
    return this.init;
  }

  get caps(): any { return this.init?.agentCapabilities ?? {}; }

  request<T = any>(method: string, params: unknown): Promise<T> {
    return (this.conn!.agent as any).request(method, params);
  }
  notify(method: string, params: unknown) { return (this.conn!.agent as any).notify(method, params); }

  onExit(fn: (code: number | null) => void) { this.exitHandlers.add(fn); }
  /** Agent log lines (stderr). Used by presets to surface errors ACP itself doesn't report. */
  onStderrLine(fn: (line: string) => void) { this.stderrLineHandlers.add(fn); }
  alive() { return !!this.proc && this.proc.exitCode === null && !this.proc.killed; }

  async stop() {
    this.stopping = true;
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const t = setTimeout(() => this.proc?.kill("SIGKILL"), 3000);
      await this.proc.exited.catch(() => {});
      clearTimeout(t);
    }
  }
}
