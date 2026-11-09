// Local HTTP API + web dashboard. 127.0.0.1 by default; a token is required for any
// non-loopback bind. /api/send and /api/trigger stay v2-compatible.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { ChannelManager, Logger, RuntimeEvent, StateStore } from "@uniqlaw/core";
import { loadJobs, nextMatch } from "@uniqlaw/scheduler";

export interface ApiOptions {
  /** Throws if the on-disk settings are invalid (checked before a reload is accepted). */
  validateSettings?: () => void;
  manager: ChannelManager;
  store: StateStore;
  host: string;
  port: number;
  log: Logger;
  version: string;
  /** Resolved web.token (required when host is not loopback). */
  token?: string;
  logFile: string;
  /** Absolute cron jobs dir. */
  jobsDir: string;
  timezone: string;
  /** Manual dreaming sweep (POST /api/dream). */
  dream?: (o: { dryRun?: boolean }) => Promise<unknown>;
}

const WEB_DIR = join(import.meta.dir, "web");
const STATIC: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

export function isLoopback(host: string) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host.startsWith("127.");
}

/** Last `n` lines of a file without reading it all. */
export function tailFile(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const chunk = Math.min(size, Math.max(64 * 1024, n * 400));
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(chunk);
    readSync(fd, buf, 0, chunk, size - chunk);
    const lines = buf.toString("utf8").split("\n");
    if (chunk < size) lines.shift(); // partial first line
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-n);
  } finally { closeSync(fd); }
}

export function startApi(o: ApiOptions) {
  const { manager, store, log } = o;
  if (!isLoopback(o.host) && !o.token) {
    throw new Error(`web.host ${o.host} is not loopback: set web.token (a SecretRef) to protect the API, or bind 127.0.0.1`);
  }
  const json = (v: unknown, status = 200) => Response.json(v, { status });

  const authorized = (req: Request) => {
    if (!o.token) return true;
    const h = req.headers.get("authorization");
    if (h === `Bearer ${o.token}`) return true;
    const cookie = req.headers.get("cookie") ?? "";
    return cookie.split(/;\s*/).some((c) => c === `uq_token=${encodeURIComponent(o.token!)}`);
  };

  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const onEvent = (ev: RuntimeEvent) => {
    const frame = enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    for (const c of sseClients) { try { c.enqueue(frame); } catch { sseClients.delete(c); } }
  };
  manager.events.on("event", onEvent);
  const keepAlive = setInterval(() => { for (const c of sseClients) { try { c.enqueue(enc.encode(": ping\n\n")); } catch { sseClients.delete(c); } } }, 20_000);

  const agentsDetail = () => manager.listAgents().map((a) => {
    const row = store.getSession(a.name);
    return { ...a, providerSessionId: row?.providerSessionId ?? null, lastTarget: row?.lastTarget ? JSON.parse(row.lastTarget) : null,
      pending: row ? store.countPending(a.name) : 0, createdAt: row?.createdAt ?? null };
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: o.host, port: o.port, idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        try {
          // Login: /?token=… sets the cookie (non-loopback deployments).
          if (req.method === "GET" && STATIC[path]) {
            if (o.token && url.searchParams.get("token") === o.token) {
              return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `uq_token=${encodeURIComponent(o.token)}; HttpOnly; SameSite=Strict; Path=/` } });
            }
            if (!authorized(req)) return new Response("unauthorized — open /?token=<web.token>", { status: 401 });
            const file = join(WEB_DIR, STATIC[path]!);
            return new Response(readFileSync(file), { headers: { "content-type": MIME[file.split(".").pop()!]!, "cache-control": "no-store" } });
          }
          if (!path.startsWith("/api/")) return json({ ok: false, error: "not found" }, 404);
          if (!authorized(req)) return json({ ok: false, error: "unauthorized" }, 401);

          if (req.method === "GET" && path === "/api/status") return json({ ok: true, version: o.version, agents: manager.listAgents() });
          if (req.method === "GET" && path === "/api/agents") return json({ ok: true, agents: agentsDetail() });
          if (req.method === "GET" && path === "/api/jobs") {
            const jobs = loadJobs(o.jobsDir).map((j) => ({ name: j.name, schedule: j.schedule, recurring: j.recurring, target: j.target,
              replyTo: j.replyTo ?? null, timezone: j.timezone ?? o.timezone, next: nextMatch(j.schedule, new Date(), j.timezone ?? o.timezone)?.toISOString() ?? null, prompt: j.body }));
            return json({ ok: true, jobs });
          }
          if (req.method === "GET" && path === "/api/logs") {
            const n = Math.min(Math.max(Number(url.searchParams.get("lines") ?? 200) || 200, 1), 5000);
            return json({ ok: true, lines: tailFile(o.logFile, n) });
          }
          if (req.method === "GET" && path === "/api/events") {
            let ctl!: ReadableStreamDefaultController<Uint8Array>;
            const stream = new ReadableStream<Uint8Array>({
              start(c) { ctl = c; sseClients.add(c); c.enqueue(enc.encode(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)); },
              cancel() { sseClients.delete(ctl); },
            });
            req.signal.addEventListener("abort", () => { sseClients.delete(ctl); try { ctl.close(); } catch {} });
            return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
          }
          const m = path.match(/^\/api\/sessions\/([^/]+)\/(transcript|stop|reset)$/);
          if (m) {
            const key = decodeURIComponent(m[1]!);
            if (req.method === "GET" && m[2] === "transcript") {
              const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 500);
              const after = Number(url.searchParams.get("after") ?? 0) || 0;
              return json({ ok: true, key, entries: manager.transcript?.list(key, limit, after) ?? [] });
            }
            if (req.method === "POST" && m[2] === "stop") {
              const rt = manager.runtimes.get(key);
              return json({ ok: true, stopped: rt ? await rt.stop() : false });
            }
            if (req.method === "POST" && m[2] === "reset") {
              if (!store.getSession(key) && !manager.runtimes.has(key)) return json({ ok: false, error: "unknown session" }, 404);
              await manager.runtime(key).reset();
              return json({ ok: true });
            }
          }
          if (req.method === "POST" && path === "/api/reload") {
            // Handled by runForever's SIGHUP handler (validates settings, then restarts in-process).
            try { o.validateSettings?.(); } catch (e) {
              return json({ ok: false, error: `settings rejected, keeping the running config: ${e instanceof Error ? e.message : String(e)}` }, 400);
            }
            setTimeout(() => process.kill(process.pid, "SIGHUP"), 10);
            return json({ ok: true, reloading: true });
          }
          if (req.method === "POST" && path === "/api/send") {
            const b = (await req.json()) as { target?: string; text?: string; fromLabel?: string };
            if (!b.target || !b.text) return json({ ok: false, error: "target and text are required" }, 400);
            const r = await manager.notify(b.fromLabel ?? "api", b.target, b.text);
            return json({ ok: true, target: r.target, inboxOwner: r.owner });
          }
          if (req.method === "POST" && path === "/api/trigger") {
            const b = (await req.json()) as { target?: string; prompt?: string; fromLabel?: string; replyTo?: { platform: string; chatId: string | number; threadId?: string } };
            if (!b.target || !b.prompt) return json({ ok: false, error: "target and prompt are required" }, 400);
            const replyTo = b.replyTo ? { platform: b.replyTo.platform, chatId: String(b.replyTo.chatId), threadId: b.replyTo.threadId } : undefined;
            const r = await manager.trigger(b.fromLabel ?? "api", b.target, b.prompt, replyTo);
            return json({ ok: true, dispatched: true, target: b.target, taskId: r.taskId });
          }
          if (req.method === "GET" && path === "/api/workers") {
            return json({ ok: true, workers: manager.listAgents().filter((a) => a.kind === "worker") });
          }
          if (req.method === "POST" && path === "/api/workers") {
            const b = (await req.json()) as { action?: "start" | "stop"; name?: string; profile?: string; cwd?: string; task?: string; forget?: boolean; fromLabel?: string };
            if (!b.name) return json({ ok: false, error: "name is required" }, 400);
            if (b.action === "stop") return json({ ok: true, ...(await manager.stopWorker(b.name, !!b.forget)) });
            const r = await manager.startWorker(b.fromLabel ?? "api", { name: b.name, profile: b.profile, cwd: b.cwd, task: b.task, wait: false });
            return json({ ok: true, ...r });
          }
          if (req.method === "POST" && path === "/api/takeover") {
            const b = (await req.json()) as { key?: string };
            if (!b.key) return json({ ok: false, error: "key is required" }, 400);
            return json({ ok: true, ...(await manager.takeover(b.key)) });
          }
          if (req.method === "POST" && path === "/api/release") {
            const b = (await req.json()) as { key?: string };
            if (!b.key) return json({ ok: false, error: "key is required" }, 400);
            return json({ ok: true, released: manager.release(b.key) });
          }
          if (req.method === "POST" && path === "/api/dream") {
            if (!o.dream) return json({ ok: false, error: "UniQlaw memory is disabled (settings.memory.enabled)" }, 400);
            const b = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
            return json({ ok: true, report: await o.dream({ dryRun: !!b.dryRun }) });
          }
          return json({ ok: false, error: "not found" }, 404);
        } catch (e) {
          log.warn("api error", { path, e: String(e) });
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
        }
      },
    });
  } catch (e) {
    manager.events.off("event", onEvent);
    clearInterval(keepAlive);
    if ((e as { code?: string }).code === "EADDRINUSE") {
      throw new Error(`web.port ${o.port} is already in use${o.port === 4632 ? " — is ClaudeClaw v2 still running? Stop it first, or set web.port to 0 (auto)" : ""}`);
    }
    throw e;
  }
  log.info("api listening", { url: `http://${o.host}:${server.port}`, auth: !!o.token });
  return {
    port: server.port,
    stop: () => {
      manager.events.off("event", onEvent);
      clearInterval(keepAlive);
      for (const c of sseClients) { try { c.close(); } catch {} }
      sseClients.clear();
      server.stop(true);
    },
  };
}
