// Local fake Discord (Gateway WS + REST). Never talk to real Discord in tests.
import type { ServerWebSocket } from "bun";

export interface RestCall { method: string; path: string; body: any }

export function startFakeDiscord(opts: { botId?: string; appId?: string } = {}) {
  const botId = opts.botId ?? "900";
  const calls: RestCall[] = [];
  const identifies: any[] = [];
  /** Every gateway frame the client sent (for conformance checks). */
  const frames: any[] = [];
  let socket: ServerWebSocket<unknown> | null = null;
  let seq = 0;
  let nextId = 5000;
  const files = new Map<string, Uint8Array>();

  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/gateway") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (url.pathname.startsWith("/files/")) {
        const f = files.get(url.pathname.slice(7));
        return f ? new Response(Buffer.from(f)) : new Response("nope", { status: 404 });
      }
      if (url.pathname.startsWith("/cdn/stickers/")) return new Response(Buffer.from([1, 2, 3]));
      const m = url.pathname.match(/^\/api(\/.*)$/);
      if (!m) return new Response("nf", { status: 404 });
      const path = m[1]!;
      if (req.headers.get("authorization") !== "Bot TEST-DC") return Response.json({ message: "401" }, { status: 401 });
      const text = await req.text();
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ method: req.method, path, body });
      if (req.method === "POST" && /^\/channels\/\d+\/messages$/.test(path)) return Response.json({ id: String(nextId++), channel_id: path.split("/")[2] });
      if (req.method === "POST" && path === "/users/@me/channels") return Response.json({ id: `77${body.recipient_id}`, type: 1 });
      return new Response(null, { status: 204 });
    },
    websocket: {
      open(ws) { socket = ws; ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } })); },
      message(ws, raw) {
        const p = JSON.parse(String(raw));
        frames.push(p);
        if (p.op === 6) ws.send(JSON.stringify({ op: 0, t: "RESUMED", s: ++seq, d: {} }));
        if (p.op === 2) {
          identifies.push(p.d);
          ws.send(JSON.stringify({ op: 0, t: "READY", s: ++seq, d: { user: { id: botId, username: "uqbot" }, application: { id: opts.appId ?? "app1" }, session_id: "sess", resume_gateway_url: null } }));
        }
        if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
      },
      close() { socket = null; },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    botId, calls, identifies, frames,
    /** Send a raw gateway op (e.g. 1 = heartbeat request, 7 = reconnect). */
    sendOp(op: number, d: unknown = null) { socket?.send(JSON.stringify({ op, d })); },
    apiBase: `${base}/api`, gatewayUrl: `ws://127.0.0.1:${server.port}/gateway`, cdnBase: `${base}/cdn`, fileBase: `${base}/files`,
    addFile(name: string, data: Uint8Array) { files.set(name, data); },
    dispatch(t: string, d: unknown) { socket?.send(JSON.stringify({ op: 0, t, s: ++seq, d })); },
    callsTo: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)),
    stop: () => server.stop(true),
  };
}
