import { join, resolve } from "node:path";
import type { AgentProvider, AgentSession, Logger, Profile, ProviderCapabilities, SessionSpec } from "@uniqlaw/core";
import { resolveCredential } from "@uniqlaw/credentials";
import { AGY_CAPABILITIES, credentialEnv, permissionArgs } from "./mapping.ts";
import { AgySession } from "./session.ts";

export interface AgyProviderConfig {
  agyPath: string;
  /** Command that runs the stdio MCP shim (`uniqlaw mcp-shim`). */
  shimCommand?: string[];
  effort?: string;
  extraArgs: string[];
  /** Run agy with an isolated HOME (config, MCP schema cache, conversations) per instance. */
  isolateHome: boolean;
}

/** Default shim: this monorepo's CLI entry, run with the current bun. */
export function defaultShimCommand(): string[] {
  return [process.execPath, resolve(import.meta.dir, "..", "..", "cli", "src", "main.ts"), "mcp-shim"];
}

export class AgyProvider implements AgentProvider {
  readonly name = "agy";
  constructor(private cfg: AgyProviderConfig, private deps: { log: Logger; stateDir: string }) {}

  capabilities(_p: Profile): ProviderCapabilities { return AGY_CAPABILITIES; }

  async open(spec: SessionSpec): Promise<AgentSession> {
    const opts = spec.profile.options as { effort?: string };
    const cred = spec.profile.credentialResolved ? await resolveCredential(spec.profile.credentialResolved) : undefined;
    const home = this.cfg.isolateHome ? join(this.deps.stateDir, "agy-home", spec.instanceId) : undefined;
    const ce = credentialEnv(cred, home);
    for (const w of ce.warnings) this.deps.log.warn(w);
    const perm = permissionArgs(spec.profile.permissions);
    if (perm.unmapped.length) this.deps.log.warn("tools without an agy permission rule (ignored)", { tools: perm.unmapped });
    const slug = spec.sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    const fragments = spec.systemPrompt.fragments.map((f) => f.text).join("\n\n");
    if (fragments) this.deps.log.debug("agy: system prompt fragments are sent with the first turn of each process");
    const session = new AgySession({
      agyPath: this.cfg.agyPath,
      cwd: spec.cwd,
      env: Object.fromEntries(Object.entries({ ...spec.env, ...ce.env })
        // API-key mode: GOOGLE_API_KEY would take precedence and AGY_ADC_AUTH would switch sign-in mode.
        .filter(([k]) => !(cred?.kind === "gemini-api-key" && (k === "GOOGLE_API_KEY" || k === "AGY_ADC_AUTH")))),
      model: spec.profile.model,
      effort: opts.effort ?? this.cfg.effort,
      conversationId: spec.providerSessionId,
      workspaceDir: join(this.deps.stateDir, "agy-workspaces", spec.instanceId, slug),
      mcp: spec.mcp ? { url: spec.mcp.url, token: spec.mcp.token, shimCommand: this.cfg.shimCommand ?? defaultShimCommand() } : undefined,
      settings: perm.settings,
      flags: perm.flags,
      extraArgs: this.cfg.extraArgs,
      log: this.deps.log.child(slug),
    });
    session.start();
    return fragments ? withSystemPrompt(session, fragments, !spec.providerSessionId) : session;
  }
}

/** agy has no system-prompt flag: prefix the fragments to the first turn of a NEW conversation
 *  (resumed conversations already carry them in history). */
function withSystemPrompt(s: AgySession, fragments: string, isNew: boolean): AgentSession {
  if (!isNew) return s;
  let pending = true;
  const send = s.send.bind(s);
  s.send = async (input) => {
    if (pending && !input.slashCommand) {
      pending = false;
      return send({ ...input, text: `<system-instructions>\n${fragments}\n</system-instructions>\n\n${input.text}` });
    }
    return send(input);
  };
  return s;
}
