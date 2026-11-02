// MCP Gateway (docs §8.3): Streamable HTTP at /mcp/<token>. The token identifies
// the calling session; tools never accept a "who am I" argument.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ChannelManager } from "./manager.ts";
import type { GatewayTool, Logger } from "./plugin.ts";

export const GATEWAY_TOOL_NAMES = ["agents_list", "agent_ask", "agent_trigger", "notify", "task_status"];

export class McpGateway {
  private extra: GatewayTool[] = [];
  private tokens = new Map<string, string>(); // token → channelKey
  private byKey = new Map<string, string>();  // channelKey → token
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private manager: () => ChannelManager, private log: Logger) {}

  start(host: string, port: number) {
    this.server = Bun.serve({
      hostname: host, port, idleTimeout: 255,
      fetch: (req) => this.handle(req),
    });
    this.log.info("mcp gateway listening", { url: `http://${host}:${this.server.port}` });
    return this.server.port;
  }

  stop() { this.server?.stop(true); }

  /** Plugin-contributed tools (registered before sessions open, so prompts list them). */
  addTools(tools: GatewayTool[]) { this.extra.push(...tools); }

  toolNames() { return [...GATEWAY_TOOL_NAMES, ...this.extra.map((t) => t.name)]; }

  get port() { return this.server?.port; }

  /** Stable per-channel token for this daemon run. */
  endpointFor(channelKey: string) {
    if (!this.server) return undefined;
    let token = this.byKey.get(channelKey);
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      this.byKey.set(channelKey, token);
      this.tokens.set(token, channelKey);
    }
    return { url: `http://${this.server.hostname}:${this.server.port}/mcp/${token}`, token, toolNames: this.toolNames() };
  }

  private async handle(req: Request): Promise<Response> {
    const m = new URL(req.url).pathname.match(/^\/mcp\/([a-f0-9]+)$/);
    const caller = m ? this.tokens.get(m[1]!) : undefined;
    if (!caller) return new Response("unknown token", { status: 401 });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await this.build(caller).connect(transport);
    return transport.handleRequest(req);
  }

  private build(caller: string): McpServer {
    const s = new McpServer({ name: "uniqlaw", version: "0.1.0" });
    const mgr = this.manager();
    const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
    const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
      try { return ok(await fn(a)); } catch (e) { this.log.warn("tool failed", { caller, e: String(e) }); return fail(e); }
    };

    s.registerTool("agents_list", { description: "List other UniQlaw agent sessions you can reach (name, profile, provider, state).", inputSchema: {} },
      wrap(async () => mgr.listAgents().filter((a) => a.name !== caller)));

    s.registerTool("agent_ask", {
      description: "Ask another agent session something. Its answer comes back to YOU; no human sees it. wait=true (default) blocks until it answers; wait=false returns a taskId and the answer arrives later as a new message.",
      inputSchema: { to: z.string().describe("agent name from agents_list"), message: z.string(), wait: z.boolean().optional() } },
      wrap(async ({ to, message, wait }) => {
        const r = await mgr.ask(caller, to, message, wait ?? true);
        return r.result ? (r.result.ok ? r.result.text : `failed: ${r.result.text}`) : { taskId: r.taskId, status: "working" };
      }));

    s.registerTool("agent_trigger", {
      description: "Make another session answer ITS OWN human: it runs a turn and its reply is posted to that session's chat.",
      inputSchema: { to: z.string(), prompt: z.string(),
        replyTo: z.object({ platform: z.string(), chatId: z.string(), threadId: z.string().optional() }).optional() } },
      wrap(async ({ to, prompt, replyTo }) => mgr.trigger(caller, to, prompt, replyTo)));

    s.registerTool("notify", {
      description: "Send text you wrote to a chat target (a human sees it verbatim), e.g. target \"telegram:<chatId>\".",
      inputSchema: { target: z.string(), text: z.string() } },
      wrap(async ({ target, text }) => mgr.notify(caller, target, text)));

    s.registerTool("task_status", { description: "Status/result of an agent_ask or agent_trigger task.", inputSchema: { taskId: z.string() } },
      wrap(async ({ taskId }) => {
        const t = mgr.taskStatus(taskId);
        if (!t || (t.fromSession !== caller && t.toSession !== caller)) throw new Error("unknown task");
        return { state: t.state, result: t.result };
      }));

    for (const t of this.extra) {
      s.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema },
        wrap(async (a: Record<string, unknown>) => t.handler(a, caller)));
    }
    return s;
  }
}
