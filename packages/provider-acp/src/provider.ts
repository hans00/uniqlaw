// Generic ACP provider. Default: one agent process per UniQlaw session (ACP agents
// can't be trusted with per-session MCP isolation — M0: opencode acp leaks identity).
// `shareProcess: true` pools sessions per (command, env) for agents that pass the
// cross-session isolation contract test.
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentSession, Logger, Profile, ProviderCapabilities, SessionSpec } from "@uniqlaw/core";
import { envFor, resolveCredential, type ResolvedCredential } from "@uniqlaw/credentials";
import { configContent as opencodeConfig, homeFor as opencodeHome, serveEnv as opencodeEnv } from "@uniqlaw/provider-opencode";
import { AcpAgent } from "./agent.ts";
import { AcpSession } from "./session.ts";
import { capabilitiesFor, opencodeLogError, type AcpProfileOptions } from "./mapping.ts";

export interface AcpProviderConfig {
  /** Agent command, e.g. ["opencode","acp"], ["gemini","--acp"], ["claude-agent-acp"]. */
  command: string[];
  env: Record<string, string>;
  /** "opencode": isolate config/data and map PermissionPolicy into OPENCODE_CONFIG_CONTENT. "auto" picks by command. */
  preset: "auto" | "opencode" | "generic";
  shareProcess: boolean;
  startTimeoutMs: number;
}

interface Pooled { key: string; agent: AcpAgent; sessions: Set<AcpSession> }

export class AcpProvider implements AgentProvider {
  readonly name: string;
  private pool = new Map<string, Pooled>();

  constructor(private cfg: AcpProviderConfig, private deps: { log: Logger; stateDir: string; name?: string }) {
    this.name = deps.name ?? "acp";
  }

  private preset(): "opencode" | "generic" {
    if (this.cfg.preset !== "auto") return this.cfg.preset;
    return basename(this.cfg.command[0] ?? "") === "opencode" ? "opencode" : "generic";
  }

  capabilities(profile: Profile): ProviderCapabilities {
    const o = profile.options as AcpProfileOptions;
    return capabilitiesFor({
      steer: o.steer === "concurrent-prompt",
      modelSwitch: o.modelSwitch ?? (this.preset() === "opencode" ? "live" : "spawn"),
      shareProcess: this.cfg.shareProcess,
    });
  }

  private env(spec: SessionSpec, cred: ResolvedCredential | undefined): Record<string, string> {
    const o = spec.profile.options as AcpProfileOptions;
    if (this.preset() === "opencode") {
      // MCP goes through session/new, so keep it out of the config file.
      const cfgContent = opencodeConfig({ ...spec, mcp: undefined }, spec.profile.model) as Record<string, unknown>;
      const home = opencodeHome(this.deps.stateDir, cred);
      mkdirSync(join(home, "prompts"), { recursive: true });
      const system = spec.systemPrompt.fragments.map((f) => f.text).join("\n\n");
      if (system) {
        // opencode reads extra system instructions from files listed in `instructions`.
        const file = join(home, "prompts", `${spec.sessionId.replace(/[^\w.-]/g, "_")}.md`);
        writeFileSync(file, system);
        cfgContent.instructions = [file];
      }
      return { ...opencodeEnv(spec, cred, { stateDir: this.deps.stateDir, userConfig: !!o.userConfig, userData: !!o.userData }, cfgContent), ...this.cfg.env, ...o.agentEnv };
    }
    const base: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "LANG", "USER", "TMPDIR", "TERM"]) if (process.env[k]) base[k] = process.env[k]!;
    return { ...base, ...spec.env, ...(cred ? envFor(cred) : {}), ...this.cfg.env, ...o.agentEnv };
  }

  private async agentFor(spec: SessionSpec, env: Record<string, string>): Promise<Pooled> {
    const key = this.cfg.shareProcess ? createHash("sha256").update(JSON.stringify([this.cfg.command, env, spec.cwd])).digest("hex") : crypto.randomUUID();
    const existing = this.pool.get(key);
    if (existing && existing.agent.alive()) return existing;
    // opencode acp swallows model errors (it retries forever) — have it log, and watch the log.
    const isOpencode = this.preset() === "opencode";
    const command = isOpencode && !this.cfg.command.includes("--print-logs") ? [...this.cfg.command, "--print-logs"] : this.cfg.command;
    const agent = new AcpAgent({ command, cwd: spec.cwd, env, log: this.deps.log.child(`acp:${basename(this.cfg.command[0] ?? "agent")}`), clientName: "uniqlaw" });
    await agent.start(this.cfg.startTimeoutMs);
    const entry: Pooled = { key, agent, sessions: new Set() };
    if (isOpencode) {
      agent.onStderrLine((line) => {
        const hit = opencodeLogError(line);
        if (hit) for (const s of entry.sessions) if (s.id === hit.sessionId) void s.providerError(hit.code);
      });
    }
    agent.onExit((code) => { this.pool.delete(key); for (const s of entry.sessions) s.crashed(code); });
    this.pool.set(key, entry);
    return entry;
  }

  async open(spec: SessionSpec): Promise<AgentSession> {
    const cred = spec.profile.credentialResolved ? await resolveCredential(spec.profile.credentialResolved) : undefined;
    const entry = await this.agentFor(spec, this.env(spec, cred));
    const { agent } = entry;
    const log = this.deps.log.child(`acp:${spec.sessionId}`);
    const caps = agent.caps;
    const mcpServers: unknown[] = [];
    if (spec.mcp) {
      if (caps.mcpCapabilities?.http) mcpServers.push({ type: "http", name: "uniqlaw", url: spec.mcp.url, headers: [] });
      else log.warn("agent does not support HTTP MCP servers; UniQlaw bus tools are unavailable in this session");
    }
    const session = new AcpSession(this.capabilities(spec.profile), agent, log, {
      onClose: async (s) => {
        entry.sessions.delete(s);
        agent.sinks.delete(s.id);
        if (entry.sessions.size === 0) { this.pool.delete(entry.key); await agent.stop(); }
      },
    });
    try {
      let id: string | undefined;
      let result: any;
      if (spec.providerSessionId && (caps.loadSession || caps.sessionCapabilities?.resume)) {
        agent.sinks.set(spec.providerSessionId, session);
        session.id = spec.providerSessionId;
        try {
          if (caps.loadSession) {
            session.replaying = true; // history is replayed as session/update until load resolves
            result = await agent.request("session/load", { sessionId: spec.providerSessionId, cwd: spec.cwd, mcpServers });
          } else {
            result = await agent.request("session/resume", { sessionId: spec.providerSessionId, cwd: spec.cwd, mcpServers });
          }
          id = spec.providerSessionId;
        } catch (e) {
          log.warn("resume failed; starting a new ACP session", { e: String(e) });
          agent.sinks.delete(spec.providerSessionId);
        } finally {
          session.replaying = false;
        }
      } else if (spec.providerSessionId) {
        log.warn("agent cannot load sessions; starting a new one", { id: spec.providerSessionId });
      }
      if (!id) {
        result = await agent.request("session/new", { cwd: spec.cwd, mcpServers });
        id = result.sessionId as string;
        agent.sinks.set(id, session);
      }
      session.id = id;
      if (result?.configOptions) session.configOptions = result.configOptions;
      // Generic agents have no system-prompt channel: prefix the first prompt of a NEW session.
      if (this.preset() !== "opencode" && id !== spec.providerSessionId) {
        const system = spec.systemPrompt.fragments.map((f) => f.text).join("\n\n");
        if (system) session.pendingSystem = system;
      }
      entry.sessions.add(session);
      // System prompt: ACP has no system-prompt field; agents get it as the first context
      // via their own config (opencode preset) or not at all. Model: apply profile.model.
      if (spec.profile.model && session.modelOption()) {
        await session.setModel(spec.profile.model).catch((e) => log.warn("initial model not applied", { e: String(e) }));
      }
      session.emit({ type: "session", providerSessionId: id });
      return session;
    } catch (e) {
      if (entry.sessions.size === 0) { this.pool.delete(entry.key); await agent.stop(); }
      throw e;
    }
  }
}
