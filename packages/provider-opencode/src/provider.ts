// OpencodeProvider: one `opencode serve` per UniQlaw session (MCP is instance-wide,
// M0 S6), isolated XDG config/data under the instance state dir.
import { mkdirSync } from "node:fs";
import type { AgentProvider, AgentSession, Logger, Profile, ProviderCapabilities, SessionSpec } from "@uniqlaw/core";
import { resolveCredential } from "@uniqlaw/credentials";
import { OpencodeServer } from "./server.ts";
import { OPENCODE_CAPABILITIES, OpencodeSession } from "./session.ts";
import { configContent, homeFor, permissionRules, serveEnv } from "./mapping.ts";

export interface OpencodeProviderConfig {
  opencodePath: string;
  startTimeoutMs: number;
  /** Model when the profile has none, e.g. "opencode/nemotron-3.5-lightning-free". */
  defaultModel?: string;
}

export class OpencodeProvider implements AgentProvider {
  readonly name = "opencode";
  constructor(private cfg: OpencodeProviderConfig, private deps: { log: Logger; stateDir: string }) {}

  capabilities(_p: Profile): ProviderCapabilities { return OPENCODE_CAPABILITIES; }

  async open(spec: SessionSpec): Promise<AgentSession> {
    const opts = spec.profile.options as { userConfig?: boolean; userData?: boolean };
    const cred = spec.profile.credentialResolved ? await resolveCredential(spec.profile.credentialResolved) : undefined;
    const model = spec.profile.model ?? this.cfg.defaultModel;
    mkdirSync(homeFor(this.deps.stateDir, cred), { recursive: true });
    // Inherit + override (architecture §13 #9): read the user's own opencode config/data by
    // default (like Claude/codex read ~/.claude, ~/.codex); UniQlaw's enforced settings come
    // in via OPENCODE_CONFIG_CONTENT. A provider-login credential with its own `home` means a
    // different account → isolate into that home instead.
    const altAccount = cred?.kind === "provider-login" && !!cred.home;
    const env = serveEnv(spec, cred, { stateDir: this.deps.stateDir,
      userConfig: opts.userConfig ?? !altAccount, userData: opts.userData ?? !altAccount }, configContent(spec, model));
    const log = this.deps.log.child(`opencode:${spec.sessionId}`);
    // NB: opencode's bash tool runs at the git worktree root, not `directory` (M0 trap 3);
    // the serve cwd is spec.cwd so non-git projects behave, and session cwd isolation must
    // not rely on subdirectories of one repo.
    const server = new OpencodeServer({ bin: this.cfg.opencodePath, cwd: spec.cwd, env, log, startTimeoutMs: this.cfg.startTimeoutMs });
    await server.start();
    const system = spec.systemPrompt.fragments.map((f) => f.text).join("\n\n") || undefined;
    const session = new OpencodeSession(server, log, { model, system });
    const permission = permissionRules(spec.profile.permissions);
    try {
      let id: string | undefined;
      if (spec.providerSessionId) {
        try {
          await server.api("GET", `/session/${spec.providerSessionId}`);
          await server.api("PATCH", `/session/${spec.providerSessionId}`, { permission }).catch((e) => log.warn("permission refresh failed", { e: String(e) }));
          id = spec.providerSessionId;
        } catch (e) {
          log.warn("resume target not found; starting a new opencode session", { id: spec.providerSessionId, e: String(e) });
        }
      }
      if (!id) id = (await server.api<{ id: string }>("POST", "/session", { title: `uniqlaw ${spec.sessionId}`, permission })).id;
      session.id = id;
      session.emit({ type: "session", providerSessionId: id });
      return session;
    } catch (e) {
      await server.stop();
      throw e;
    }
  }
}
