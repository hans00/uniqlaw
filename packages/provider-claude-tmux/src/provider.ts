import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentSession, Logger, Profile, ProviderCapabilities, SessionSpec } from "@uniqlaw/core";
import {
  baseChildEnv, buildPermissionArgs, claudeSettingsArgs, claudeEnvForCredential, composeAppendSystemPrompt, locateJsonl,
  MCP_SERVER_NAME, mcpToolId, writeMcpConfig,
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

    const existing = spec.providerSessionId ? locateJsonl(providerSessionId, env) : undefined;
    const dir = join(this.deps.stateDir, "claude-tmux", slug(spec.sessionId));
    mkdirSync(dir, { recursive: true });
    const settingsFile = join(dir, "settings.json");
    const launchArgs = (resume: boolean) => {
      const argv = [this.cfg.claudePath, resume ? "--resume" : "--session-id", providerSessionId];
      if (spec.profile.model) argv.push("--model", spec.profile.model);
      argv.push(...buildPermissionArgs(spec.profile.permissions, {
        modeOverride: opts.permissionMode,
        // With a channel policy the granted UniQlaw tools are named one by one, so a policy change also changes
        // the launch flags (fingerprint below) and a reattached claude is respawned with the new tool list.
        extraAllowed: !spec.mcp ? [] : spec.toolPolicy ? spec.mcp.toolNames.map(mcpToolId) : [`mcp__${MCP_SERVER_NAME}`],
        ...(spec.toolPolicy ? { toolPolicy: spec.toolPolicy } : {}),
        isolated: !!spec.isolated,
      }));
      const append = composeAppendSystemPrompt({
        parts: spec.systemPrompt, permissions: spec.profile.permissions, cwd: spec.cwd, mcpToolNames: spec.mcp?.toolNames, isolated: !!spec.isolated,
      });
      // Via a file: tmux rejects a new-session command over ~16 KB ("command too long"),
      // and MEMORY.md alone may be up to 24 KB.
      if (append) {
        const file = join(dir, "append-system-prompt.md");
        writeFileSync(file, append, { mode: 0o600 });
        argv.push("--append-system-prompt-file", file);
      }
      if (spec.mcp) argv.push("--mcp-config", writeMcpConfig(join(dir, "mcp.json"), spec.mcp.url));
      // Approval judge on: Claude Code's PermissionRequest hook hands the structured request to the daemon first
      // (judge off: no hook, the flags stay exactly as before).
      const judge = spec.profile.permissions.approval.judge;
      const hookUrl = judge && judge.mode !== "off" && spec.profile.permissions.approval.mode === "ask-operator" ? spec.mcp?.permissionHookUrl : undefined;
      argv.push(...claudeSettingsArgs({ nativeMemory: spec.isolated ? false : spec.nativeMemory,
        ...(hookUrl ? { permissionHook: { url: hookUrl, timeoutSec: Math.ceil(judge!.timeoutMs / 1000) + 5, file: settingsFile } } : {}) }));
      // Judge off now: a settings file left from a judge-on launch (it holds the hook token) goes.
      if (!hookUrl) rmSync(settingsFile, { force: true });
      // Operator extras could re-add settings sources or MCP servers: not for remote-driven sessions.
      if (opts.extraArgs?.length && !spec.isolated) argv.push(...opts.extraArgs);
      return argv;
    };
    const launchFile = join(dir, "launch.sha");
    const tailStateFile = join(dir, "tail.json");
    const spawn = async (resume: boolean) => {
      const argv = launchArgs(resume);
      await tmux.newSession(name, { cwd: spec.cwd, env, argv, width: this.cfg.width, height: this.cfg.height });
      writeFileSync(launchFile, launchFingerprint(argv));
    };

    // Reattach after a daemon restart.
    if (spec.providerSessionId && (await tmux.hasSession(name)) && !(await tmux.paneDead(name))) {
      // The live claude keeps the flags it was started with (permission mode, model, tools, …). If the profile
      // changed since, respawn it with --resume once it is idle; the conversation is kept.
      const want = launchFingerprint(launchArgs(true));
      const had = existsSync(launchFile) ? readFileSync(launchFile, "utf8").trim() : undefined;
      const stale = had !== want;
      log.info("reattaching to existing tmux session", { name, ...(stale ? { staleLaunchArgs: true } : {}) });
      const respawn = async () => {
        log.info("respawning claude with the current profile flags (--resume)", { name });
        await tmux.killSession(name);
        await spawn(!!locateJsonl(providerSessionId, env));
      };
      const s = new ClaudeTmuxSession({ tmux, name, providerSessionId, cwd: spec.cwd, env, log, timings: this.cfg.timings,
        respawn, readyTimeoutMs: this.cfg.readyTimeoutMs, tailStateFile, settingsFile }, "end");
      await s.start({ reattach: true, staleLaunch: stale });
      this.sessions.set(spec.sessionId, s);
      return s;
    }
    await tmux.killSession(name); // dead pane left by remain-on-exit

    if (existing && this.cfg.takeOverLegacy) {
      const killed = await killLegacySessions(providerSessionId, this.deps.legacy ?? systemLegacyDeps());
      if (killed.length) log.warn("killed legacy tmux sessions holding this claude session", { killed });
    }

    log.info("spawning claude", { name, resume: !!existing, providerSessionId });
    await spawn(!!existing);
    // A fresh session id: an old position means nothing. --resume (claude exited while the daemon was down) keeps
    // appending to the same jsonl, so the saved position still applies.
    if (!existing) rmSync(tailStateFile, { force: true });
    const s = new ClaudeTmuxSession({ tmux, name, providerSessionId, cwd: spec.cwd, env, log, timings: this.cfg.timings, tailStateFile, settingsFile },
      existing ? "end" : "start");
    await s.start({ reattach: false, readyTimeoutMs: this.cfg.readyTimeoutMs });
    this.sessions.set(spec.sessionId, s);
    return s;
  }
}

/** Launch flags that matter for a live process: everything but the session-id/resume pair. */
export function launchFingerprint(argv: string[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify([argv[0], ...argv.slice(3)])).digest("hex");
}
