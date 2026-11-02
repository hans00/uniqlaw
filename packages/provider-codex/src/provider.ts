// CodexProvider: pools `codex app-server` processes by (args, env) and hosts one
// thread per UniQlaw session. Per-thread MCP isolation holds (M0 S6 + contract S6b),
// so sessions with the same credentials share a process.
import { createHash } from "node:crypto";
import type { AgentProvider, AgentSession, Logger, Profile, ProviderCapabilities, SessionSpec } from "@uniqlaw/core";
import { AppServer } from "./rpc.ts";
import { CODEX_CAPABILITIES, CodexSession } from "./session.ts";
import { credentialSetup, policyFor, processArgs, threadConfig } from "./mapping.ts";

export interface CodexProviderConfig {
  codexPath: string;
  /** Default reasoning effort when the profile doesn't set options.effort. */
  effort?: string;
  /** Extra `codex app-server` args (e.g. ["-c", "foo=bar"]). */
  extraArgs: string[];
  /** Kill a process this long after its last thread closes. */
  idleKillMs: number;
}

interface PoolEntry {
  key: string;
  server: AppServer;
  ready: Promise<unknown>;
  threads: Map<string, CodexSession>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export const VERSION = "0.1.0";

export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  private pool = new Map<string, PoolEntry>();

  constructor(private cfg: CodexProviderConfig, private deps: { log: Logger }) {}

  capabilities(_profile: Profile): ProviderCapabilities { return CODEX_CAPABILITIES; }

  async open(spec: SessionSpec): Promise<AgentSession> {
    const opts = spec.profile.options as { effort?: string; wireApi?: string };
    const cred = await credentialSetup(spec.profile.credentialResolved, { wireApi: opts.wireApi });
    // codex needs PATH (to find itself/tools) and HOME (for ~/.codex); take them from the
    // daemon only when the spec doesn't provide them. Nothing else leaks in.
    const base: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "LANG", "USER", "TMPDIR"]) if (process.env[k]) base[k] = process.env[k]!;
    const env = { ...base, ...spec.env, ...cred.env };
    const args = [...processArgs(), ...cred.configArgs, ...this.cfg.extraArgs];
    const entry = await this.process(args, env, spec.cwd);
    const log = this.deps.log.child(`codex:${spec.sessionId}`);
    const policy = policyFor(spec.profile.permissions, spec.cwd);
    const session: CodexSession = new CodexSession({
      server: entry.server, log, cwd: spec.cwd, model: spec.profile.model, effort: opts.effort ?? this.cfg.effort, policy,
      onClose: (s) => this.release(entry, s),
    });
    const common = {
      model: spec.profile.model ?? null,
      modelProvider: cred.modelProvider ?? null,
      cwd: spec.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      config: threadConfig(spec.mcp, spec.profile.permissions.level),
      developerInstructions: spec.systemPrompt.fragments.map((f) => f.text).join("\n\n") || null,
    };
    let threadId: string | undefined;
    if (spec.providerSessionId) {
      try {
        const r = await entry.server.request<{ thread: { id: string } }>("thread/resume", { threadId: spec.providerSessionId, ...common, excludeTurns: true });
        threadId = r.thread.id;
      } catch (e) {
        log.warn("thread/resume failed; starting a new thread", { e: String(e) });
      }
    }
    if (!threadId) {
      const r = await entry.server.request<{ thread: { id: string } }>("thread/start", { ...common, ephemeral: false });
      threadId = r.thread.id;
    }
    session.threadId = threadId;
    clearTimeout(entry.idleTimer);
    entry.threads.set(threadId, session);
    session.emit({ type: "session", providerSessionId: threadId });
    return session;
  }

  private async process(args: string[], env: Record<string, string>, cwd: string): Promise<PoolEntry> {
    const key = createHash("sha256").update(JSON.stringify({ p: this.cfg.codexPath, args, env })).digest("hex").slice(0, 16);
    const existing = this.pool.get(key);
    if (existing && !existing.server.exited) { await existing.ready; return existing; }
    const log = this.deps.log.child(`codex-proc:${key.slice(0, 6)}`);
    const server = new AppServer({ codexPath: this.cfg.codexPath, args, env, cwd, log });
    const entry: PoolEntry = { key, server, threads: new Map(), ready: server.initialize(VERSION) };
    server.onNotification = (method, params) => {
      const s = params?.threadId ? entry.threads.get(params.threadId) : undefined;
      s?.onNotification(method, params);
    };
    server.onServerRequest = (method, params, id) => {
      const s = params?.threadId ? entry.threads.get(params.threadId) : undefined;
      if (s) return s.onServerRequest(method, params, id);
      if (method === "currentTime/read") return server.respond(id, { currentTimeAt: Date.now() });
      log.warn("codex: server request for unknown thread", { method });
      server.respondError(id, -32601, `UniQlaw does not handle ${method}`);
    };
    server.onExit((code) => {
      log.warn("codex app-server exited", { code, stderr: server.stderrTail.slice(-300) });
      for (const s of entry.threads.values()) s.onServerExit(`codex app-server exited (${code})`);
      entry.threads.clear();
      if (this.pool.get(key) === entry) this.pool.delete(key);
    });
    this.pool.set(key, entry);
    try {
      await entry.ready;
    } catch (e) {
      this.pool.delete(key);
      await server.kill();
      throw new Error(`codex app-server failed to start: ${e instanceof Error ? e.message : String(e)}`);
    }
    log.info("codex app-server started", { pid: server.pid });
    return entry;
  }

  private release(entry: PoolEntry, s: CodexSession) {
    if (entry.threads.get(s.threadId) === s) entry.threads.delete(s.threadId);
    if (entry.threads.size === 0) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        if (entry.threads.size) return;
        if (this.pool.get(entry.key) === entry) this.pool.delete(entry.key);
        void entry.server.kill();
      }, this.cfg.idleKillMs);
    }
  }

  /** Stop all processes (tests / daemon shutdown). */
  async shutdown() {
    const all = [...this.pool.values()];
    this.pool.clear();
    for (const e of all) { clearTimeout(e.idleTimer); await e.server.kill(); }
  }
}
