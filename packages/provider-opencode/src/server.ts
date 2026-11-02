// One `opencode serve` process: spawn, health, JSON API, SSE event stream.
import type { Logger } from "@uniqlaw/core";

export type RawEvent = { type: string; properties: any };

export class OpencodeServer {
  proc?: ReturnType<typeof Bun.spawn>;
  base = "";
  private sse = new AbortController();
  private listeners = new Set<(e: RawEvent) => void>();
  private stderrTail = "";

  constructor(private opts: { bin: string; cwd: string; env: Record<string, string>; log: Logger; startTimeoutMs: number }) {}

  async start(): Promise<void> {
    const { bin, cwd, env, log } = this.opts;
    this.proc = Bun.spawn([bin, "serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`opencode serve did not start within ${this.opts.startTimeoutMs}ms: ${this.stderrTail.slice(-500)}`)), this.opts.startTimeoutMs);
      const scan = async (stream: ReadableStream<Uint8Array>, isErr: boolean) => {
        const dec = new TextDecoder();
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          const s = dec.decode(chunk);
          if (isErr) this.stderrTail = (this.stderrTail + s).slice(-4000);
          const m = s.match(/listening on (http:\/\/[\d.]+:\d+)/);
          if (m) { clearTimeout(t); resolve(m[1]!); }
        }
      };
      void scan(this.proc!.stdout as ReadableStream<Uint8Array>, false);
      void scan(this.proc!.stderr as ReadableStream<Uint8Array>, true);
      void this.proc!.exited.then((code) => { clearTimeout(t); reject(new Error(`opencode serve exited (${code}): ${this.stderrTail.slice(-500)}`)); });
    });
    this.base = url;
    log.debug("opencode serve up", { url, pid: this.proc.pid });
    await this.connectEvents();
  }

  private dirQuery(path: string) {
    return `${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(this.opts.cwd)}`;
  }

  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.base + this.dirQuery(path), {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t.slice(0, 300)}`);
    return (t ? JSON.parse(t) : null) as T;
  }

  on(fn: (e: RawEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private async connectEvents() {
    const res = await fetch(this.base + this.dirQuery("/event"), { signal: this.sse.signal });
    if (!res.ok || !res.body) throw new Error(`event stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
            if (!data) continue;
            let e: RawEvent;
            try { e = JSON.parse(data); } catch { continue; }
            for (const l of this.listeners) { try { l(e); } catch (err) { this.opts.log.error("event listener failed", { err: String(err) }); } }
          }
        }
      } catch { /* aborted */ }
      for (const l of this.listeners) l({ type: "uniqlaw.stream_closed", properties: {} });
    })();
  }

  alive() { return !!this.proc && this.proc.exitCode === null && !this.proc.killed; }

  async stop() {
    this.sse.abort();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const t = setTimeout(() => this.proc?.kill("SIGKILL"), 3000);
      await this.proc.exited.catch(() => {});
      clearTimeout(t);
    }
  }
}
