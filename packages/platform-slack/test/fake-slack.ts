// Local fake Slack (Web API + Socket Mode WS). Never talk to real Slack in tests.
import type { ServerWebSocket } from "bun";

export interface WebCall { method: string; token: string; body: any }

export function startFakeSlack(opts: { botUserId?: string; botId?: string } = {}) {
  const botUserId = opts.botUserId ?? "UBOT";
  const calls: WebCall[] = [];
  const acks: string[] = [];
  let socket: ServerWebSocket<unknown> | null = null;
  let ts = 1700000000;
  let env = 0;
  const files = new Map<string, Uint8Array>();
  let port = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/socket") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (url.pathname.startsWith("/files/")) {
        if (req.headers.get("authorization") !== "Bearer xoxb-test") return new Response("auth", { status: 403 });
        const f = files.get(url.pathname.slice(7));
        return f ? new Response(Buffer.from(f)) : new Response("nf", { status: 404 });
      }
      const m = url.pathname.match(/^\/api\/([\w.]+)$/);
      if (!m) return new Response("nf", { status: 404 });
      const method = m[1]!;
      const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
      const text = await req.text();
      const body = text && req.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {};
      calls.push({ method, token, body });
      const ok = (o: Record<string, unknown> = {}) => Response.json({ ok: true, ...o });
      switch (method) {
        case "auth.test": return token === "xoxb-test" ? ok({ user_id: botUserId, bot_id: opts.botId ?? "BBOT", user: "uqbot" }) : Response.json({ ok: false, error: "invalid_auth" });
        case "apps.connections.open": return token === "xapp-test" ? ok({ url: `ws://127.0.0.1:${port}/socket` }) : Response.json({ ok: false, error: "invalid_auth" });
        case "users.info": return ok({ user: { name: `n${body.user}`, real_name: `Real ${body.user}`, profile: { display_name: "" } } });
        case "chat.postMessage": return ok({ ts: `${ts++}.000100`, channel: body.channel });
        case "conversations.open": return ok({ channel: { id: `D${body.users}` } });
        default: return ok();
      }
    },
    websocket: {
      open(ws) { socket = ws; ws.send(JSON.stringify({ type: "hello" })); },
      message(_ws, raw) { const p = JSON.parse(String(raw)); if (p.envelope_id) acks.push(p.envelope_id); },
      close() { socket = null; },
    },
  });
  port = server.port!;
  const base = `http://127.0.0.1:${server.port}`;
  return {
    botUserId, calls, acks, webApiBase: `${base}/api`, fileBase: `${base}/files`,
    addFile(name: string, data: Uint8Array) { files.set(name, data); },
    event(event: unknown) { const id = `e${++env}`; socket?.send(JSON.stringify({ type: "events_api", envelope_id: id, payload: { event } })); return id; },
    interactive(payload: unknown) { const id = `i${++env}`; socket?.send(JSON.stringify({ type: "interactive", envelope_id: id, payload })); return id; },
    callsOf: (method: string) => calls.filter((c) => c.method === method),
    stop: () => server.stop(true),
  };
}
