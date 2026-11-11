// MCP Gateway (docs §8.3): Streamable HTTP at /mcp/<token>. The token identifies
// the calling session; tools never accept a "who am I" argument.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { ChannelManager } from "./manager.ts";
import type { GatewayTool, Logger } from "./plugin.ts";

export const GATEWAY_TOOL_NAMES = ["agents_list", "agent_ask", "agent_trigger", "notify", "send_file", "task_status", "worker_start", "worker_stop"];

export class McpGateway {
  private extra: GatewayTool[] = [];
  private tokens = new Map<string, string>(); // token → channelKey
  private byKey = new Map<string, string>();  // channelKey → token
  private server?: ReturnType<typeof Bun.serve>;

  private lastPort?: number;

  /** `stateFile` keeps the port and channel tokens across daemon restarts: claude-tmux sessions outlive
   *  the daemon and are reattached with the MCP URL they were spawned with, so that URL must stay valid. */
  constructor(private manager: () => ChannelManager, private log: Logger, private stateFile?: string) {
    if (stateFile && existsSync(stateFile)) {
      try {
        const s = JSON.parse(readFileSync(stateFile, "utf8")) as { port?: number; tokens?: Record<string, string> };
        this.lastPort = s.port;
        for (const [key, token] of Object.entries(s.tokens ?? {})) {
          this.byKey.set(key, token);
          this.tokens.set(token, key);
        }
      } catch (e) { log.warn("ignoring unreadable gateway state file", { file: stateFile, error: String(e) }); }
    }
  }

  private save() {
    if (this.stateFile) writeFileSync(this.stateFile, JSON.stringify({ port: this.server?.port, tokens: Object.fromEntries(this.byKey) }, null, 2), { mode: 0o600 });
  }

  /** With `port` 0, the previous run's port is tried first (see constructor). */
  start(host: string, port: number) {
    const serve = (p: number) => Bun.serve({ hostname: host, port: p, idleTimeout: 255, fetch: (req) => this.handle(req) });
    if (port === 0 && this.lastPort) {
      try { this.server = serve(this.lastPort); } catch { this.log.warn("previous gateway port taken; reattached sessions lose MCP until respawned", { port: this.lastPort }); }
    }
    this.server ??= serve(port);
    this.save();
    this.log.info("mcp gateway listening", { url: `http://${host}:${this.server.port}` });
    return this.server.port;
  }

  stop() { this.server?.stop(true); }

  /** Plugin-contributed tools (registered before sessions open, so prompts list them). */
  addTools(tools: GatewayTool[]) { this.extra.push(...tools); }

  toolNames() { return [...GATEWAY_TOOL_NAMES, ...this.extra.map((t) => t.name)]; }

  get port() { return this.server?.port; }

  /** The session a gateway token belongs to (proof that a caller runs as that session, e.g. `uniqlaw restart`). */
  sessionForToken(token: string): string | undefined { return this.tokens.get(token); }

  /** Stable per-channel token (kept across restarts when a state file is set). */
  endpointFor(channelKey: string) {
    if (!this.server) return undefined;
    let token = this.byKey.get(channelKey);
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      this.byKey.set(channelKey, token);
      this.tokens.set(token, channelKey);
      this.save();
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

    s.registerTool("send_file", {
      description: "Post a local file (image, audio, voice note, video or document) to a chat; a human sees it. Default target: your own chat. "
        + "Use this instead of calling a chat platform's API yourself. Files must be inside the project, your working directory, the temp dir or the configured roots.",
      inputSchema: {
        path: z.string().describe("absolute, ~ or relative to your working directory"),
        target: z.string().optional().describe("chat target like \"telegram:<chatId>\"; omit for your own chat"),
        caption: z.string().optional(),
        kind: z.enum(["image", "audio", "voice", "video", "file"]).optional().describe("how to show it; default from the extension (.ogg/.opus = voice note)"),
        name: z.string().optional().describe("file name shown in the chat"),
      } },
      wrap(async (a) => mgr.sendFile(caller, a)));

    s.registerTool("task_status", { description: "Status/result of an agent_ask or agent_trigger task.", inputSchema: { taskId: z.string() } },
      wrap(async ({ taskId }) => {
        const t = mgr.taskStatus(taskId);
        if (!t || (t.fromSession !== caller && t.toSession !== caller)) throw new Error("unknown task");
        return { state: t.state, result: t.result };
      }));

    s.registerTool("worker_start", {
      description: "Start (or reuse) a worker: another coding agent session (a profile, e.g. Claude Code or Codex) working in a directory on this machine. "
        + "With a task, it works on it like agent_ask; wait=false (default) returns a taskId and its final report arrives later as a new message. "
        + "Talk to it afterwards with agent_ask to \"worker:<name>\". A human can take it over (/attach in chat, `uniqlaw attach` in a terminal); while they do, it rejects your messages.",
      inputSchema: {
        name: z.string().describe("short id, lowercase (becomes worker:<name>); reusing a name continues that worker's conversation"),
        profile: z.string().optional().describe("profile to run (which agent/model/permissions); required for a new worker"),
        cwd: z.string().optional().describe("working directory (absolute, ~ or relative to the project); must be inside the allowed worker roots; fixed per worker"),
        task: z.string().optional().describe("what to do; omit to just start it"),
        wait: z.boolean().optional(),
      } },
      wrap(async (a) => {
        const r = await mgr.startWorker(caller, a);
        const { result, ...rest } = r;
        return result ? { ...rest, result: result.ok ? result.text : `failed: ${result.text}` } : { ...rest, ...(r.taskId ? { status: "working" } : {}) };
      }));

    s.registerTool("worker_stop", {
      description: "Stop a worker's agent process. Its conversation is kept (worker_start with the same name resumes it) unless forget=true. Files it changed are never touched.",
      inputSchema: { name: z.string(), forget: z.boolean().optional() } },
      wrap(async ({ name, forget }) => mgr.stopWorker(name, forget ?? false)));

    for (const t of this.extra) {
      s.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema },
        wrap(async (a: Record<string, unknown>) => t.handler(a, caller)));
    }
    return s;
  }
}
