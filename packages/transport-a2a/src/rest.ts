// Framework-agnostic A2A v1.0 HTTP+JSON (REST) binding over DefaultRequestHandler.
// The SDK's restHandler is express-only; this mirrors its routes for Bun.serve:
//   POST /message:send            POST /message:stream (SSE)
//   GET  /tasks/{id}              POST /tasks/{id}:cancel
//   GET|POST /tasks/{id}:subscribe (SSE)   GET /extendedAgentCard
// Paths are relative to the profile's REST interface URL; a leading /v1 is accepted too.
import {
  AgentCard, SSE_HEADERS, SendMessageRequest, SendMessageResponse, StreamResponse, Task,
  formatSSEErrorEvent, formatSSEEvent, A2A_CONTENT_TYPE,
} from "@a2a-js/sdk";
import { RequestMalformedError, restStatusFor, toRestErrorBody } from "@a2a-js/sdk/errors";
import { validateVersion, type DefaultRequestHandler, type ServerCallContext } from "@a2a-js/sdk/server";

type Json = Record<string, unknown>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": A2A_CONTENT_TYPE } });
}

function errorResponse(e: unknown) {
  const status = restStatusFor(e);
  return jsonResponse(status, toRestErrorBody(e, status));
}

function sseResponse(gen: AsyncGenerator<unknown>, first: IteratorResult<unknown>): Response {
  const enc = new TextEncoder();
  let pending: IteratorResult<unknown> | undefined = first;
  const stream = new ReadableStream({
    async pull(ctrl) {
      try {
        const r = pending ?? (await gen.next());
        pending = undefined;
        if (r.done) return ctrl.close();
        ctrl.enqueue(enc.encode(formatSSEEvent(StreamResponse.toJSON(r.value as never))));
      } catch (err) {
        ctrl.enqueue(enc.encode(formatSSEErrorEvent(toRestErrorBody(err, restStatusFor(err)))));
        ctrl.close();
      }
    },
    cancel() { void gen.return?.(undefined); },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** Open a stream and pull its first item before committing to SSE, so setup errors become JSON errors. */
async function stream(gen: AsyncGenerator<unknown>): Promise<Response> {
  let first: IteratorResult<unknown>;
  try { first = await gen.next(); } catch (e) { return errorResponse(e); }
  return sseResponse(gen, first);
}

function parseSend(body: Json) {
  const params = SendMessageRequest.fromJSON(body as never);
  if (!params.message) throw new RequestMalformedError("message is required");
  if (!params.message.messageId) throw new RequestMalformedError("message.messageId is required");
  return params;
}

function toSendResponse(result: unknown) {
  const r = result as Json;
  const payload = "messageId" in r ? { $case: "message", value: r } : { $case: "task", value: r };
  return SendMessageResponse.toJSON({ payload } as never);
}

export async function handleRest(
  handler: DefaultRequestHandler, card: unknown, subpath: string, req: Request, context: ServerCallContext,
): Promise<Response> {
  try {
    validateVersion(context.requestedVersion, card as never, "HTTP+JSON");
    const path = subpath.replace(/^\/v1(?=\/)/, "");
    const url = new URL(req.url);
    const ct = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const readBody = async (): Promise<Json> => {
      if (ct && ct !== "application/json" && ct !== A2A_CONTENT_TYPE) throw new RequestMalformedError(`unsupported Content-Type "${ct}"`);
      const text = await req.text();
      if (!text) return {};
      try { return JSON.parse(text) as Json; } catch { throw new RequestMalformedError("Invalid JSON payload."); }
    };

    if (req.method === "POST" && path === "/message:send") {
      const result = await handler.sendMessage(parseSend(await readBody()), context);
      return jsonResponse(200, toSendResponse(result));
    }
    if (req.method === "POST" && path === "/message:stream") {
      return stream(handler.sendMessageStream(parseSend(await readBody()), context) as AsyncGenerator<unknown>);
    }
    if (req.method === "GET" && path === "/extendedAgentCard") {
      return jsonResponse(200, AgentCard.toJSON(await handler.getAuthenticatedExtendedAgentCard({ tenant: "" } as never, context)));
    }
    const m = path.match(/^\/tasks\/([^/:]+)(?::(cancel|subscribe))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (!m[2] && req.method === "GET") {
        const hl = url.searchParams.get("historyLength");
        const params: Json = { id, tenant: "" };
        if (hl !== null) {
          const n = Number(hl);
          if (!Number.isInteger(n) || n < 0) throw new RequestMalformedError("historyLength must be a non-negative integer");
          params.historyLength = n;
        }
        return jsonResponse(200, Task.toJSON(await handler.getTask(params as never, context)));
      }
      if (m[2] === "cancel" && req.method === "POST") {
        return jsonResponse(200, Task.toJSON(await handler.cancelTask({ id, tenant: "", metadata: {} } as never, context)));
      }
      if (m[2] === "subscribe" && (req.method === "GET" || req.method === "POST")) {
        return stream(handler.resubscribe({ id, tenant: "" } as never, context) as AsyncGenerator<unknown>);
      }
    }
    return jsonResponse(404, { error: { code: 404, status: "NOT_FOUND", message: `no route ${req.method} ${path}`, details: [] } });
  } catch (e) {
    return errorResponse(e);
  }
}
