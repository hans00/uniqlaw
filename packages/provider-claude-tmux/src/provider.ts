import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentSession, Logger, Profile, ProviderCapabilities, SessionSpec } from "@uniqlaw/core";
import {
  baseChildEnv, buildPermissionArgs, nativeMemoryArgs, claudeEnvForCredential, composeAppendSystemPrompt, locateJsonl,
  MCP_SERVER_NAME, writeMcpConfig,
} from "@uniqlaw/claude-common";
import { Tmux } from "./tmux.ts";
import { ClaudeTmuxSession, CLAUDE_TMUX_CAPABILITIES, newProviderSessionId, type Timings } from "./session.ts";
import { killLegacySessions, systemLegacyDeps, type LegacyDeps } from "./legacy.ts";

export interface ClaudeTmuxConfig {
  claudePath: string;
  readyTimeoutMs: number;
  width: number;
  height: number;
  /** Kill v2 `claudeclaw-*` processes on the default tmux socket that hold the session being resumed. */
  takeOverLegacy: boolean;
  timings?: Partial<Timings>;
}

export interface ClaudeTmuxDeps {
  log: Logger;
  stateDir: string;
  legacy?: LegacyDeps;
}

export function slug(s: string): string {
  const clean = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (clean.length <= 40) return clean || "s";
  // keep it unique but short
  const h = Bun.hash(s).toString(36).slice(0, 8);
  return `${clean.slice(0, 31)}-${h}`;
}

export class ClaudeTmuxProvider implements AgentProvider {
  readonly name = "claude-tmux";
  private sessions = new Map<string, ClaudeTmuxSession>();

  constructor(private cfg: ClaudeTmuxConfig, private deps: ClaudeTmuxDeps) {}

  capabilities(_p: Profile): ProviderCapabilities { return CLAUDE_TMUX_CAPABILITIES; }

  tmuxFor(instanceId: string): Tmux {
    return new Tmux(`uniqlaw-${instanceId}`, baseChildEnv());
  }

  sessionName(instanceId: string, sessionId: string): string {
    return `uq-${instanceId}-${slug(sessionId)}`;
  }

  /** Live terminal takeover: attach to the agent's own tmux session (core keeps watching). */
  attachCommand(o: { instanceId: string; sessionId: string }): { argv: string[]; live: boolean } {
    return { argv: ["tmux", "-L", this.tmuxFor(o.instanceId).socket, "attach-session", "-t", this.sessionName(o.instanceId, o.sessionId)], live: true };
  }

  async open(spec: SessionSpec): Promise<AgentSession> {
    const log = this.deps.log.child(spec.sessionId);
    const tmux = this.tmuxFor(spec.instanceId);
    const name = this.sessionName(spec.instanceId, spec.sessionId);
    const credEnv = await claudeEnvForCredential(spec.profile.credentialResolved);
    const env: Record<string, string> = { ...baseChildEnv(), ...spec.env, ...credEnv };
    const providerSessionId = spec.providerSessionId ?? newProviderSessionId();
    const opts = spec.profile.options as { permissionMode?: string; extraArgs?: string[] };

    this.sessions.get(spec.sessionId)?.detach();

    // Reattach after a daemon restart.
    if (spec.providerSessionId && (await tmux.hasSession(name)) && !(await tmux.paneDead(name))) {
      log.info("reattaching to existing tmux session", { name });
      const s = new ClaudeTmuxSession({ tmux, name, providerSessionId, cwd: spec.cwd, env, log, timings: this.cfg.timings }, "end");
      await s.start({ reattach: true });
      this.sessions.set(spec.sessionId, s);
      return s;
    }
    await tmux.killSession(name); // dead pane left by remain-on-exit

    const existing = spec.providerSessionId ? locateJsonl(providerSessionId, env) : undefined;
    if (existing && this.cfg.takeOverLegacy) {
      const killed = await killLegacySessions(providerSessionId, this.deps.legacy ?? systemLegacyDeps());
      if (killed.length) log.warn("killed legacy tmux sessions holding this claude session", { killed });
    }

    const argv = [this.cfg.claudePath, existing ? "--resume" : "--session-id", providerSessionId];
    if (spec.profile.model) argv.push("--model", spec.profile.model);
    argv.push(...buildPermissionArgs(spec.profile.permissions, {
      modeOverride: opts.permissionMode,
      extraAllowed: spec.mcp ? [`mcp__${MCP_SERVER_NAME}`] : [],
    }));
    const append = composeAppendSystemPrompt({
      parts: spec.systemPrompt, permissions: spec.profile.permissions, cwd: spec.cwd, mcpToolNames: spec.mcp?.toolNames,
    });
    if (append) argv.push("--append-system-prompt", append);
    if (spec.mcp) {
      const dir = join(this.deps.stateDir, "claude-tmux", slug(spec.sessionId));
      mkdirSync(dir, { recursive: true });
      argv.push("--mcp-config", writeMcpConfig(join(dir, "mcp.json"), spec.mcp.url));
    }
    argv.push(...nativeMemoryArgs(spec.nativeMemory));
    if (opts.extraArgs?.length) argv.push(...opts.extraArgs);

    log.info("spawning claude", { name, resume: !!existing, providerSessionId });
    await tmux.newSession(name, { cwd: spec.cwd, env, argv, width: this.cfg.width, height: this.cfg.height });
    const s = new ClaudeTmuxSession({ tmux, name, providerSessionId, cwd: spec.cwd, env, log, timings: this.cfg.timings },
      existing ? "end" : "start");
    await s.start({ reattach: false, readyTimeoutMs: this.cfg.readyTimeoutMs });
    this.sessions.set(spec.sessionId, s);
    return s;
  }
}
