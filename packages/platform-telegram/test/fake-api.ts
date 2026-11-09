// Local fake Telegram Bot API (never talk to the real API in tests).
import type { TgUpdate } from "../src/api.ts";

export interface Call { method: string; body: Record<string, any> }

export function startFakeBotApi(opts: { token?: string; botUsername?: string; botId?: number; rejectUpload?: string[] } = {}) {
  const token = opts.token ?? "TEST:TOKEN";
  const calls: Call[] = [];
  const updates: TgUpdate[] = [];
  const waiters: (() => void)[] = [];
  const files = new Map<string, { path: string; data: Uint8Array }>();
  let nextMsgId = 1000;
  /** When true, sendMessage with parse_mode=HTML fails like a bad-entity error. */
  let rejectHtml = false;
  let updateSeq = 1;

  const ok = (result: unknown) => Response.json({ ok: true, result });
  const fail = (code: number, description: string) => Response.json({ ok: false, error_code: code, description }, { status: code });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const fileMatch = url.pathname.match(new RegExp(`^/file/bot${escapeRe(token)}/(.+)$`));
      if (fileMatch) {
        const f = [...files.values()].find((x) => x.path === fileMatch[1]);
        return f ? new Response(Buffer.from(f.data)) : new Response("nope", { status: 404 });
      }
      const m = url.pathname.match(new RegExp(`^/bot${escapeRe(token)}/(\\w+)$`));
      if (!m) return fail(404, "Not Found");
      const method = m[1]!;
      const body = (await readBody(req)) as Record<string, any>;
      calls.push({ method, body });
      switch (method) {
        case "getMe": return ok({ id: opts.botId ?? 999, is_bot: true, first_name: "Bot", username: opts.botUsername ?? "uniq_test_bot" });
        case "getUpdates": {
          const offset = Number(body.offset ?? 0);
          // Like Telegram: an offset confirms (deletes) every earlier update, so a restarted poller
          // starting from offset 0 only gets what was never confirmed.
          if (offset > 0) for (let i = updates.length - 1; i >= 0; i--) if (updates[i]!.update_id < offset) updates.splice(i, 1);
          const take = () => updates.filter((u) => u.update_id >= offset);
          if (!take().length) {
            // long-poll: wait for an update or a short timeout
            await new Promise<void>((r) => { const t = setTimeout(r, Math.min(Number(body.timeout ?? 0), 1) * 1000 || 50); waiters.push(() => { clearTimeout(t); r(); }); });
          }
          return ok(take());
        }
        case "sendMessage": {
          if (rejectHtml && body.parse_mode === "HTML") return fail(400, "Bad Request: can't parse entities");
          return ok({ message_id: nextMsgId++, chat: { id: Number(body.chat_id) }, text: body.text });
        }
        case "sendPhoto": case "sendAudio": case "sendVoice": case "sendVideo": case "sendDocument": {
          if (opts.rejectUpload?.includes(method)) return fail(400, "Bad Request: wrong file type");
          return ok({ message_id: nextMsgId++, chat: { id: Number(body.chat_id) } });
        }
        case "editMessageText": return ok(true);
        case "deleteMessage": return ok(true);
        case "setMessageReaction": return ok(true);
        case "setMyCommands": return ok(true);
        case "sendChatAction": return ok(true);
        case "answerCallbackQuery": return ok(true);
        case "getFile": {
          const f = files.get(String(body.file_id));
          return f ? ok({ file_id: body.file_id, file_path: f.path }) : fail(400, "Bad Request: invalid file_id");
        }
        default: return fail(404, `unknown method ${method}`);
      }
    },
  });

  return {
    token,
    apiBase: `http://127.0.0.1:${server.port}`,
    calls,
    callsOf: (method: string) => calls.filter((c) => c.method === method),
    pushUpdate(u: Omit<TgUpdate, "update_id">) {
      updates.push({ update_id: updateSeq++, ...u } as TgUpdate);
      waiters.splice(0).forEach((w) => w());
    },
    addFile(fileId: string, path: string, data: Uint8Array) { files.set(fileId, { path, data }); },
    setRejectHtml(v: boolean) { rejectHtml = v; },
    stop: () => server.stop(true),
  };
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** JSON body, or multipart fields (files become { name, size, type }). */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("multipart/form-data")) return (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of (await req.formData()).entries()) {
    out[k] = typeof v === "string" ? v : { name: (v as File).name, size: (v as File).size, type: (v as File).type };
  }
  return out;
}
