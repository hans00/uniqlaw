// Newline-delimited JSON-RPC 2.0 client for `codex app-server` over stdio.
import { spawn, type Subprocess } from "bun";
import type { Logger } from "@uniqlaw/core";

export type RpcId = number | string;

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(`${method}: ${message} (${code})`);
  }
}

export interface AppServerOptions {
  codexPath: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  log: Logger;
}

export class AppServer {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void; method: string }>();
  private exitListeners: ((code: number | null) => void)[] = [];
  onNotification: (method: string, params: any) => void = () => {};
  onServerRequest: (method: string, params: any, id: RpcId) => void = () => {};
  stderrTail = "";
  exited = false;

  constructor(private o: AppServerOptions) {
    this.proc = spawn([o.codexPath, "app-server", ...o.args], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: o.env, cwd: o.cwd,
    });
    void this.readLoop();
    void this.readStderr();
    void this.proc.exited.then((code) => {
      this.exited = true;
      const err = new Error(`codex app-server exited (${code}): ${this.stderrTail.slice(-500)}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const l of this.exitListeners) l(code);
    });
  }

  get pid() { return this.proc.pid; }
  onExit(fn: (code: number | null) => void) { this.exitListeners.push(fn); }

  private async readStderr() {
    const dec = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderrTail = (this.stderrTail + dec.decode(chunk)).slice(-4000);
    }
  }

  private async readLoop() {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { this.o.log.warn("codex: unparsable line", { line: line.slice(0, 200) }); continue; }
        try { this.dispatch(msg); } catch (e) { this.o.log.error("codex: dispatch failed", { e: String(e) }); }
      }
    }
  }

  private dispatch(msg: any) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(p.method, msg.error.code ?? 0, msg.error.message ?? JSON.stringify(msg.error), msg.error.data));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      this.onServerRequest(msg.method, msg.params, msg.id);
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params);
    }
  }

  private write(obj: unknown) {
    if (this.exited) throw new Error("codex app-server is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
    this.proc.stdin.flush();
  }

  request<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try { this.write({ jsonrpc: "2.0", id, method, params }); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  notify(method: string, params: unknown = {}) { this.write({ jsonrpc: "2.0", method, params }); }
  respond(id: RpcId, result: unknown) { try { this.write({ jsonrpc: "2.0", id, result }); } catch {} }
  respondError(id: RpcId, code: number, message: string) { try { this.write({ jsonrpc: "2.0", id, error: { code, message } }); } catch {} }

  async initialize(version: string) {
    const r = await this.request("initialize", {
      clientInfo: { name: "uniqlaw", title: "UniQlaw", version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    return r;
  }

  async kill() {
    if (this.exited) return;
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill();
    await Promise.race([this.proc.exited, Bun.sleep(3000)]);
    if (!this.exited) this.proc.kill(9);
  }
}
