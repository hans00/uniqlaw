// Minimal JSON-RPC (newline-delimited) client for `codex app-server` over stdio.
import { spawn, type Subprocess } from "bun";

export type Handler = (method: string, params: any, id?: number | string) => void;

export class AppServer {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; method: string }>();
  onNotification: Handler = () => {};
  onServerRequest: Handler = () => {};
  onRaw: (frame: any) => void = () => {};
  stderr = "";

  constructor(args: string[] = [], env: Record<string, string> = {}) {
    this.proc = spawn(["codex", "app-server", ...args], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
    });
    this.readLoop();
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of this.proc.stderr) this.stderr += dec.decode(chunk);
    })();
  }

  private async readLoop() {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { console.error("bad line", line.slice(0, 200)); continue; }
        this.onRaw(msg);
        if (msg.id !== undefined && msg.method === undefined) {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.resolve(msg.result);
        } else if (msg.id !== undefined) {
          this.onServerRequest(msg.method, msg.params, msg.id);
        } else {
          this.onNotification(msg.method, msg.params);
        }
      }
    }
  }

  private send(obj: any) { this.proc.stdin.write(JSON.stringify(obj) + "\n"); this.proc.stdin.flush(); }

  request<T = any>(method: string, params: any = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: any = {}) { this.send({ jsonrpc: "2.0", method, params }); }
  respond(id: number | string, result: any) { this.send({ jsonrpc: "2.0", id, result }); }

  async init() {
    const r = await this.request("initialize", {
      clientInfo: { name: "uniqlaw-spike", title: "uniqlaw spike", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    return r;
  }

  async close() { this.proc.stdin.end(); this.proc.kill(); await this.proc.exited; }
}
