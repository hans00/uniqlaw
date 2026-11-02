// provider-pi: UniQlaw's own harness for raw LLM APIs, built on the in-process
// @earendil-works/pi-coding-agent SDK (docs §5.1). Findings: spikes/pi/NOTES.md.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createAgentSession, createMcpExtension, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession as PiSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type {
  AgentEvent, AgentProvider, AgentSession, Logger, PermissionDecision, Profile, ProviderCapabilities, SessionSpec, ToolDef, TurnInput,
} from "@uniqlaw/core";
import { expandHome } from "@uniqlaw/core";
import { PI_COMPAT_PROVIDER, PI_PROVIDER_FOR_KIND, azureDeploymentMap, piAuthFor, resolveCredential, type ResolvedCredential } from "@uniqlaw/credentials";
import { decide, excludedTools, summarize } from "./policy.ts";
import { EventQueue } from "./queue.ts";

export const configSchema = z.object({
  /** Fallback model when a profile has none, as "<pi provider>/<model id>". */
  defaultModel: z.string().optional(),
  /** Let pi refresh model catalogs over the network at startup. */
  allowModelNetwork: z.boolean().default(false),
});
export type PiConfig = z.infer<typeof configSchema>;

/** Per-profile options (profile.options). */
export const profileOptionsSchema = z.object({
  /** Load the agent project's own pi resources (.pi/settings.json, .pi/mcp.json, extensions…).
   *  Default true: the project dir is the operator's agent project and its settings are the
   *  override layer (architecture §10.2), like Claude's project .claude/settings.json. */
  trustProject: z.boolean().default(true),
  /** Use a UniQlaw-private pi agent dir instead of the user's ~/.pi/agent (default false = inherit). */
  isolate: z.boolean().default(false),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  /** Load Agent Skills (user-level ~/.agents/skills etc.; project ones only with trustProject). Parity with Claude's user skills. */
  skills: z.boolean().default(true),
  /** Extra skill directories. */
  skillPaths: z.array(z.string()).default([]),
  /** Load AGENTS.md-style context files from cwd. */
  contextFiles: z.boolean().default(true),
  /** Model metadata for openai-compatible endpoints. */
  contextWindow: z.number().int().positive().default(128_000),
  maxTokens: z.number().int().positive().default(8192),
}).passthrough();

export const PI_CAPABILITIES: ProviderCapabilities = {
  streaming: "token",
  interrupt: true,
  steer: true,
  resume: "native",
  denyEndsTurn: false,
  modelSwitch: "live",
  permissionCallback: true,
  mcp: "per-session",
  nativeTools: true,
  attachments: ["image"],
  slashCommands: true,
};

export interface PiDeps {
  log: Logger;
  stateDir: string;
  /** Test hook: register extra providers (e.g. pi-ai's faux provider) on each runtime. */
  configureRuntime?: (rt: ModelRuntime) => void | Promise<void>;
}

const RATE_LIMIT_RE = /rate.?limit|\b429\b|too many requests|overloaded|quota exceeded|resource.?exhausted/i;
const AUTH_RE = /\b401\b|\b403\b|unauthori[sz]ed|invalid.{0,20}(api.?key|token|credential)|authentication|no (api key|credentials?)|missing.{0,20}(api.?key|auth)/i;

export function classifyError(msg: string): string {
  if (RATE_LIMIT_RE.test(msg)) return "rate_limit";
  if (AUTH_RE.test(msg)) return "auth";
  return msg;
}

export class PiProvider implements AgentProvider {
  readonly name = "pi";
  /** The user's own pi agent dir, captured before we ever set PI_CODING_AGENT_DIR ourselves. */
  private readonly userAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  private claimedAgentDir?: string;
  constructor(private cfg: PiConfig, private deps: PiDeps) {}

  capabilities(_p: Profile): ProviderCapabilities { return PI_CAPABILITIES; }

  async open(spec: SessionSpec): Promise<AgentSession> {
    const opts = profileOptionsSchema.parse(spec.profile.options ?? {});
    const log = this.deps.log.child(`pi:${spec.sessionId}`);

    const cred = spec.profile.credentialResolved ? await resolveCredential(spec.profile.credentialResolved) : undefined;
    // Inherit + override (architecture §10.2): use pi's own global agent dir (settings, skills,
    // logins, MCP) like Claude/codex use theirs. A provider-login credential with its own
    // `home` (another account) or `isolate: true` switches to a separate dir.
    const altHome = cred?.kind === "provider-login" && cred.home ? expandHome(cred.home) : undefined;
    const agentDir = altHome ?? (opts.isolate ? join(this.deps.stateDir, "pi-agent", spec.instanceId)
      : this.userAgentDir);
    mkdirSync(agentDir, { recursive: true });
    // pi's MCP OAuth store reads PI_CODING_AGENT_DIR process-wide (spike finding): one agent dir per daemon.
    if (this.claimedAgentDir && this.claimedAgentDir !== agentDir) {
      throw new Error(`pi profiles in one UniQlaw instance must share one agent dir (have ${this.claimedAgentDir}, profile wants ${agentDir}); run the other account in a separate instance`);
    }
    this.claimedAgentDir = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const { runtime, model } = await this.buildRuntime(spec.profile, cred, opts, agentDir);

    const session = new PiAgentSession(spec, log);
    await session.start({ runtime, model, agentDir, sessionDir: join(this.deps.stateDir, "pi-sessions"), opts });
    return session;
  }

  /** One ModelRuntime per session with an in-memory credential store holding only this
   *  profile's credential (pi reads provider-scoped env from it before process.env). */
  private async buildRuntime(profile: Profile, cred: ResolvedCredential | undefined, opts: z.infer<typeof profileOptionsSchema>, agentDir: string) {
    const auth = cred ? piAuthFor(cred) : undefined;
    const { provider, modelId } = this.parseModel(profile.model ?? this.cfg.defaultModel, cred);
    const usesLogin = cred?.kind === "provider-login";
    let store: InMemoryCredentialStore | undefined;
    if (!usesLogin) {
      store = new InMemoryCredentialStore();
      if (auth?.credential) {
        const credential = cred?.kind === "azure"
          ? { ...auth.credential, env: { ...auth.credential.env, ...azureDeploymentMap(modelId, cred.deployment) } }
          : auth.credential;
        await store.modify(provider, async () => credential);
      }
    }
    const runtime = await ModelRuntime.create({
      ...(usesLogin ? { authPath: auth?.authPath ?? join(agentDir, "auth.json") } : { credentials: store }),
      modelsPath: null,
      allowModelNetwork: this.cfg.allowModelNetwork,
      refreshOnCreate: false,
    });
    await this.deps.configureRuntime?.(runtime);
    if (auth?.compat) {
      runtime.registerProvider(PI_COMPAT_PROVIDER, {
        baseUrl: auth.compat.baseUrl, apiKey: auth.compat.apiKey ?? "unused", api: "openai-completions",
        models: [{ id: modelId, name: modelId, input: ["text"], reasoning: false, contextWindow: opts.contextWindow, maxTokens: opts.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } as never);
    }
    if (auth?.requestEnv) scopeRequestEnv(runtime, auth.requestEnv);
    const found = runtime.getModel(provider, modelId);
    if (!found) throw new Error(`pi: unknown model "${provider}/${modelId}" (check profile.model and the credential kind)`);
    const o = auth?.modelOverrides;
    const model = o ? { ...found, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), ...(o.headers ? { headers: { ...found.headers, ...o.headers } } : {}) } : found;
    return { runtime, model };
  }

  private parseModel(raw: string | undefined, cred: ResolvedCredential | undefined): { provider: string; modelId: string } {
    if (!raw) throw new Error("pi: profile.model is required (\"<provider>/<model>\", or a model id plus a credential)");
    const slash = raw.indexOf("/");
    // "provider/model" unless the credential pins the provider (model ids may contain "/").
    const credProvider = cred && cred.kind !== "provider-login"
      ? (cred.kind === "openai-compatible" ? PI_COMPAT_PROVIDER : PI_PROVIDER_FOR_KIND[cred.kind])
      : cred?.kind === "provider-login" ? cred.provider : undefined;
    if (credProvider && !raw.startsWith(`${credProvider}/`)) return { provider: credProvider, modelId: raw };
    if (slash <= 0) throw new Error(`pi: model "${raw}" needs a provider prefix ("openai/${raw}") or a credential`);
    return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
  }
}

interface StartArgs {
  runtime: ModelRuntime;
  model: Model<Api>;
  agentDir: string;
  sessionDir: string;
  opts: z.infer<typeof profileOptionsSchema>;
}

type Pending = { resolve: (d: PermissionDecision) => void; timer: ReturnType<typeof setTimeout> };

class PiAgentSession implements AgentSession {
  readonly capabilities = PI_CAPABILITIES;
  readonly events = new EventQueue<AgentEvent>();
  private pi!: PiSession;
  private runtime!: ModelRuntime;
  private disposed = false;
  private turnN = 0;
  private turnOpen = false;
  private aborted = false;
  private lastError?: string;
  private usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  private pending = new Map<string, Pending>();
  private busToolNames = new Set<string>();

  constructor(private spec: SessionSpec, private log: Logger) {}

  async start(a: StartArgs) {
    this.runtime = a.runtime;
    const spec = this.spec;
    for (const t of spec.nativeTools ?? []) this.busToolNames.add(t.name);
    const mcp = !spec.nativeTools?.length ? spec.mcp : undefined;

    const extension = (pi: ExtensionAPI) => {
      pi.on("tool_call", async (event: { toolCallId: string; toolName: string; input: unknown }) => {
        try { return await this.gate(event.toolCallId, event.toolName, event.input); }
        catch (e) { return { block: true, reason: `permission check failed: ${e instanceof Error ? e.message : String(e)}` }; }
      });
      if (mcp) pi.registerMcpServer("uniqlaw", { url: mcp.url, exposure: "direct" } as never);
    };
    const fragments = spec.systemPrompt.fragments.map((f) => f.text).filter(Boolean);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: spec.cwd, agentDir: a.agentDir, settingsManager,
      extensionFactories: [extension, ...(mcp ? [createMcpExtension({ logPath: join(a.agentDir, "mcp.log") })] : [])],
      appendSystemPromptOverride: (base: string[]) => [...base, ...fragments],
      noSkills: !a.opts.skills,
      additionalSkillPaths: a.opts.skills ? a.opts.skillPaths : [],
      ...(a.opts.skills ? {} : { skillsOverride: (base: { skills: unknown[] }) => ({ ...base, skills: [] }) }),
      noContextFiles: !a.opts.contextFiles,
    } as never);
    // Always decide project trust explicitly: without a resolver pi loads .pi/ resources (M0 #6).
    await resourceLoader.reload({ resolveProjectTrust: async () => a.opts.trustProject });

    mkdirSync(a.sessionDir, { recursive: true });
    const sessionManager = await this.sessionManager(a.sessionDir);
    const { session } = await createAgentSession({
      cwd: spec.cwd, model: a.model, modelRuntime: a.runtime, resourceLoader, settingsManager, sessionManager,
      ...(a.opts.thinkingLevel ? { thinkingLevel: a.opts.thinkingLevel } : {}),
      customTools: (spec.nativeTools ?? []).map(toPiTool),
      excludeTools: excludedTools(spec.profile.permissions),
    } as never);
    this.pi = session;
    await session.bindExtensions({});
    session.subscribe((e: unknown) => this.onPiEvent(e as PiEvent));
    this.events.push({ type: "session", providerSessionId: session.sessionId });
  }

  private async sessionManager(dir: string) {
    const id = this.spec.providerSessionId;
    if (id) {
      const found = (await SessionManager.list(this.spec.cwd, dir)).find((s: { id: string }) => s.id === id)
        ?? findSessionFile(dir, id);
      if (found) return SessionManager.open((found as { path: string }).path, dir);
      this.log.warn("pi session not found; starting a new one", { providerSessionId: id });
      this.events.push({ type: "error", error: `pi session ${id} not found in ${dir}; started a new conversation`, fatal: false });
    }
    return SessionManager.create(this.spec.cwd, dir);
  }

  // ── permission gate ──
  private async gate(id: string, tool: string, input: unknown): Promise<undefined | { block: true; reason: string }> {
    const isBus = this.busToolNames.has(tool) || tool.startsWith("mcp__uniqlaw__");
    const d = decide(this.spec.profile.permissions, tool, isBus);
    if (d.action === "allow") return undefined;
    if (d.action === "deny") return { block: true, reason: d.reason };
    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ behavior: "deny", message: "approval timed out" }); },
        this.spec.profile.permissions.approval.timeoutSec * 1000);
      this.pending.set(id, { resolve, timer });
      this.events.push({ type: "permission_request", id, tool, input, title: summarize(tool, input), kind: "permission" });
    });
    return decision.behavior === "allow" ? undefined : { block: true, reason: decision.message ?? `${tool} was denied by the operator` };
  }

  async respondPermission(id: string, decision: PermissionDecision) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(decision);
  }

  private denyAllPending(reason: string) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ behavior: "deny", message: reason }); this.pending.delete(id); }
  }

  // ── input ──
  async send(input: TurnInput) {
    if (this.disposed) throw new Error("session closed");
    const { text, images } = await toPrompt(input);
    // prompt() resolves when the whole run (incl. retries) ends; events carry the progress.
    void this.pi.prompt(text, { images, expandPromptTemplates: !!input.slashCommand || text.startsWith("/") }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn("prompt rejected", { msg });
      if (!this.turnOpen) { this.turnN++; this.events.push({ type: "turn_start", turnId: this.turnId() }); }
      this.turnOpen = false;
      this.events.push({ type: "turn_end", turnId: this.turnId(), reason: "error", error: classifyError(msg) });
    });
  }

  async steer(input: TurnInput) {
    if (!this.pi.isStreaming) return this.send(input);
    const { text, images } = await toPrompt(input);
    await this.pi.steer(text, images);
  }

  async interrupt() {
    this.aborted = true;
    this.denyAllPending("interrupted");
    await this.pi.abort();
  }

  async setModel(model: string) {
    const cur = this.pi.model as { provider: string } | undefined;
    const slash = model.indexOf("/");
    const [provider, id] = slash > 0 && this.runtime.getModel(model.slice(0, slash), model.slice(slash + 1))
      ? [model.slice(0, slash), model.slice(slash + 1)] : [cur?.provider ?? "", model];
    const m = this.runtime.getModel(provider, id);
    if (!m) throw new Error(`pi: unknown model "${provider}/${id}"`);
    await this.pi.setModel(m);
    this.events.push({ type: "model", model: `${provider}/${id}` });
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.denyAllPending("session closed");
    try { this.pi?.dispose(); } catch (e) { this.log.warn("dispose failed", { e: String(e) }); }
    this.events.close();
  }

  async alive() { return !this.disposed; }

  // ── pi events → AgentEvent ──
  private turnId() { return `${this.pi?.sessionId ?? this.spec.sessionId}#${this.turnN}`; }

  private onPiEvent(e: PiEvent) {
    switch (e.type) {
      case "agent_start":
        if (this.turnOpen) return; // retries / queued follow-ups stay inside the same turn
        this.turnN++; this.turnOpen = true; this.aborted = false; this.lastError = undefined;
        this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
        this.events.push({ type: "turn_start", turnId: this.turnId() });
        return;
      case "message_update": {
        const ev = e.assistantMessageEvent;
        const seg = String(e.message?.responseId ?? e.message?.timestamp ?? this.turnN);
        if (ev?.type === "text_delta") this.events.push({ type: "text", segmentId: seg, delta: ev.delta });
        else if (ev?.type === "thinking_delta") this.events.push({ type: "thinking", segmentId: seg, text: ev.delta ?? "" });
        return;
      }
      case "message_end": {
        const m = e.message;
        if (m?.role !== "assistant") return;
        if (m.stopReason === "aborted") this.aborted = true;
        if (m.stopReason === "error" && m.errorMessage) this.lastError = m.errorMessage;
        const u = m.usage;
        if (u) {
          this.usage.inputTokens += u.input ?? 0;
          this.usage.outputTokens += u.output ?? 0;
          this.usage.costUsd += u.cost?.total ?? 0;
        }
        const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        if (text) this.events.push({ type: "text", segmentId: String(m.responseId ?? m.timestamp ?? this.turnN), final: text });
        return;
      }
      case "tool_execution_start":
        this.events.push({ type: "tool_start", id: e.toolCallId!, name: e.toolName!, input: e.args });
        return;
      case "tool_execution_end": {
        const first = e.result?.content?.[0];
        this.events.push({ type: "tool_end", id: e.toolCallId!, ok: !e.isError, summary: typeof first?.text === "string" ? first.text.slice(0, 200) : undefined });
        return;
      }
      case "agent_settled": {
        if (!this.turnOpen) return;
        this.turnOpen = false;
        const reason = e.aborted || this.aborted ? "interrupted" : this.lastError ? "error" : "done";
        this.events.push({ type: "turn_end", turnId: this.turnId(), reason, usage: { ...this.usage },
          ...(reason === "error" ? { error: classifyError(this.lastError!) } : {}) });
        this.aborted = false;
        return;
      }
    }
  }
}

interface PiEvent {
  type: string;
  aborted?: boolean;
  assistantMessageEvent?: { type: string; delta?: string };
  message?: {
    role?: string; stopReason?: string; errorMessage?: string; responseId?: string; timestamp?: number;
    content?: { type: string; text?: string }[];
    usage?: { input?: number; output?: number; cost?: { total?: number } };
  };
  toolCallId?: string; toolName?: string; args?: unknown; isError?: boolean;
  result?: { content?: { text?: unknown }[] };
}

function toPiTool(t: ToolDef) {
  return defineTool({
    name: t.name, label: t.name, description: t.description,
    parameters: Type.Unsafe(t.inputSchema),
    async execute(_id: string, params: unknown) {
      const r = await t.handler(params);
      if (r.isError) throw new Error(r.text);
      return { content: [{ type: "text" as const, text: r.text }], details: undefined };
    },
  } as never);
}

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

async function toPrompt(input: TurnInput): Promise<{ text: string; images?: ImageContent[] }> {
  const images: ImageContent[] = [];
  const notes: string[] = [];
  for (const a of input.attachments) {
    const ext = a.path.split(".").pop()?.toLowerCase() ?? "";
    const mime = a.mime ?? IMAGE_MIME[ext];
    if ((a.kind === "image" || a.kind === "sticker") && mime?.startsWith("image/") && existsSync(a.path)) {
      images.push({ type: "image", data: readFileSync(a.path).toString("base64"), mimeType: mime });
    } else {
      notes.push(`[Attached ${a.kind}${a.durationSec ? ` · ${a.durationSec}s` : ""}: ${a.path}]`);
    }
  }
  const text = notes.length ? `${notes.join("\n")}\n${input.text}` : input.text;
  return { text, images: images.length ? images : undefined };
}

function findSessionFile(dir: string, id: string): { path: string } | undefined {
  // Fallback when list() filters by cwd: scan session files for the id.
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (f.endsWith(".jsonl") && f.includes(id)) return { path: join(dir, f) };
    }
  } catch {}
  return undefined;
}

/** Merge this profile's credential env into every request the session's runtime makes (pi-ai
 *  overlays `options.env` onto auth resolution and passes it to the provider API). The runtime is
 *  per session, so values never reach other profiles. */
function scopeRequestEnv(runtime: ModelRuntime, env: Record<string, string>) {
  const r = runtime as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ["stream", "streamSimple", "complete", "completeSimple"]) {
    const orig = r[m];
    if (typeof orig !== "function") continue;
    r[m] = (...args: unknown[]) => {
      const [model, ctx, options] = args as [unknown, unknown, { env?: Record<string, string> } | undefined];
      return orig.call(runtime, model, ctx, { ...options, env: { ...env, ...options?.env } });
    };
  }
}

