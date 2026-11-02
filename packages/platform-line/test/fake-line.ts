// Local fake LINE Messaging API. Never talk to real LINE in tests.
export interface ApiCall { method: string; path: string; body: any }
export function startFakeLine(opts: { botUserId?: string } = {}) {
  const calls: ApiCall[] = [];
  let sent = 9000;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer LINE-TOKEN") return new Response("auth", { status: 401 });
      const text = await req.text();
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/v2/bot/info") return Response.json({ userId: opts.botUserId ?? "Ubot", displayName: "uqbot" });
      if (/\/member\/|\/profile\//.test(url.pathname)) return Response.json({ displayName: `Name ${url.pathname.split("/").pop()}` });
      if (/\/message\/\d+\/content$/.test(url.pathname)) return new Response(Buffer.from([7, 7, 7]));
      if (url.pathname === "/v2/bot/message/reply" && body?.replyToken === "EXPIRED") return Response.json({ message: "Invalid reply token" }, { status: 400 });
      if (url.pathname === "/v2/bot/message/reply" || url.pathname === "/v2/bot/message/push") {
        return Response.json({ sentMessages: body.messages.map(() => ({ id: String(sent++) })) });
      }
      return Response.json({});
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { calls, apiBase: base, dataApiBase: base, callsTo: (p: string) => calls.filter((c) => c.path === p), stop: () => server.stop(true) };
}
