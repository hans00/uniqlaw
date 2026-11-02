// `uniqlaw init`: interactive (or --yes) wizard that writes `.uniqlaw/settings.json`.
// Never asks for or stores raw secrets: credentials and bot tokens are SecretRefs
// ({env} / {file} / {command}) that are resolved at runtime.
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSettings, type Credential, type SecretRef } from "@uniqlaw/core";

export const PROVIDERS = ["claude-tmux", "claude-sdk", "codex", "opencode", "agy", "pi"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const PLATFORMS = ["telegram", "discord", "slack", "line"] as const;
export type PlatformName = (typeof PLATFORMS)[number];

/** CLI binary each provider needs on PATH (pi runs in-process). */
export const PROVIDER_BINARY: Record<ProviderName, string | undefined> = {
  "claude-tmux": "claude", "claude-sdk": "claude", codex: "codex", opencode: "opencode", agy: "agy", pi: undefined,
};

type CredKind = "login" | "anthropic-api-key" | "openai-api-key" | "gemini-api-key" | "openai-compatible" | "aws" | "gcp" | "azure";
export const CREDENTIAL_CHOICES: Record<ProviderName, CredKind[]> = {
  "claude-tmux": ["login", "anthropic-api-key", "aws", "gcp", "azure"],
  "claude-sdk": ["login", "anthropic-api-key", "aws", "gcp", "azure"],
  codex: ["login", "openai-api-key", "openai-compatible", "azure"],
  opencode: ["login", "openai-api-key", "anthropic-api-key"],
  agy: ["login", "gemini-api-key", "gcp"],
  pi: ["openai-api-key", "anthropic-api-key", "gemini-api-key", "openai-compatible", "aws", "gcp", "azure", "login"],
};
const DEFAULT_MODEL: Partial<Record<ProviderName, string>> = { "claude-tmux": "sonnet", "claude-sdk": "sonnet" };
const DEFAULT_ENV: Record<string, string> = {
  "anthropic-api-key": "ANTHROPIC_API_KEY", "openai-api-key": "OPENAI_API_KEY", "gemini-api-key": "GEMINI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY", azure: "AZURE_OPENAI_API_KEY",
};

export interface PlatformAnswers {
  /** Secret refs keyed by the platform's config field (token, botToken, appToken, channelAccessToken, channelSecret). */
  secrets: Record<string, SecretRef>;
  allowedUserIds: string[];
}

export interface InitAnswers {
  provider: ProviderName;
  model?: string;
  credential?: Credential;
  platforms: Partial<Record<PlatformName, PlatformAnswers>>;
  web: boolean;
  heartbeat: boolean;
}

/** Secret fields per platform (config key → suggested env var). */
export const PLATFORM_SECRETS: Record<PlatformName, Record<string, string>> = {
  telegram: { token: "TELEGRAM_BOT_TOKEN" },
  discord: { token: "DISCORD_BOT_TOKEN" },
  slack: { botToken: "SLACK_BOT_TOKEN", appToken: "SLACK_APP_TOKEN" },
  line: { channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN", channelSecret: "LINE_CHANNEL_SECRET" },
};

/** "env:X" | "file:/p" | "cmd:…" | bare "X" (= env var). Rejects things that look like raw secrets. */
export function parseSecretRef(s: string): SecretRef {
  const t = s.trim();
  if (!t) throw new Error("empty secret reference");
  if (t.startsWith("env:")) return { env: t.slice(4) };
  if (t.startsWith("file:")) return { file: t.slice(5) };
  if (t.startsWith("cmd:")) return { command: t.slice(4) };
  if (/^[A-Z_][A-Z0-9_]*$/.test(t)) return { env: t };
  throw new Error(`"${redact(t)}" is not a reference — give an env var name (e.g. TELEGRAM_BOT_TOKEN), file:/path or cmd:<command>. Raw secrets are never stored.`);
}

function redact(s: string) { return s.length <= 6 ? "***" : `${s.slice(0, 3)}…`; }

export function parseIdList(s: string): string[] {
  return s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

/** Build a credential from a kind + already-parsed fields. */
export function buildCredential(kind: CredKind, f: Record<string, string>, provider: ProviderName): Credential | undefined {
  switch (kind) {
    case "login": return provider === "pi" ? { kind: "provider-login", provider: "pi" } : undefined; // provider default login
    case "anthropic-api-key": return { kind, key: parseSecretRef(f.key ?? DEFAULT_ENV[kind]!) };
    case "openai-api-key": return { kind, key: parseSecretRef(f.key ?? DEFAULT_ENV[kind]!), ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}) };
    case "gemini-api-key": return { kind, key: parseSecretRef(f.key ?? DEFAULT_ENV[kind]!) };
    case "openai-compatible": {
      if (!f.baseUrl) throw new Error("openai-compatible needs a base URL");
      return { kind, baseUrl: f.baseUrl, ...(f.key ? { key: parseSecretRef(f.key) } : {}) };
    }
    case "aws": return { kind, region: f.region || "us-east-1", ...(f.profile ? { profile: f.profile } : {}) };
    case "gcp": {
      if (!f.project) throw new Error("gcp needs a project id");
      return { kind, project: f.project, location: f.location || "us-central1", ...(f.serviceAccountFile ? { serviceAccountFile: f.serviceAccountFile } : {}) };
    }
    case "azure": {
      if (!f.endpoint) throw new Error("azure needs an endpoint");
      return { kind, endpoint: f.endpoint, ...(f.deployment ? { deployment: f.deployment } : {}),
        auth: f.key === "entra" ? { type: "entra" } : { type: "api-key", key: parseSecretRef(f.key ?? DEFAULT_ENV.azure!) } };
    }
  }
}

/** Pure: answers → settings object (validated by core's schema). */
export function buildSettings(a: InitAnswers): Record<string, unknown> {
  const profile: Record<string, unknown> = { provider: a.provider };
  if (a.model) profile.model = a.model;
  const credentials: Record<string, unknown> = {};
  if (a.credential) { credentials.main = a.credential; profile.credential = "main"; }
  const plugins: Record<string, unknown> = {};
  for (const name of PLATFORMS) {
    const p = a.platforms[name];
    if (!p) continue;
    plugins[name] = { enabled: true, ...p.secrets, allowedUserIds: p.allowedUserIds };
  }
  if (a.heartbeat) plugins.heartbeat = { enabled: true, interval: 60 };
  const settings = {
    profiles: { main: profile },
    ...(Object.keys(credentials).length ? { credentials } : {}),
    web: { enabled: a.web },
    plugins,
  };
  parseSettings(settings); // throws with a readable message if anything is off
  return settings;
}

export const PROMPT_TEMPLATES: Record<string, string> = {
  "IDENTITY.md": "# Identity\n\nWho you are in this deployment: name, role, tone. Edit me.\n",
  "USER.md": "# User\n\nWho you are talking to: names, preferences, time zone, what they care about. Edit me.\n",
  "SOUL.md": "# Soul\n\nValues and boundaries: how you behave when unsure, what you never do. Edit me.\n",
};

export function scaffoldPrompts(projectDir: string): string[] {
  const dir = join(projectDir, "prompts");
  mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  for (const [f, body] of Object.entries(PROMPT_TEMPLATES)) {
    const p = join(dir, f);
    if (!existsSync(p)) { writeFileSync(p, body); created.push(`prompts/${f}`); }
  }
  return created;
}

export function detectProviders(which: (bin: string) => string | null = Bun.which): ProviderName[] {
  return PROVIDERS.filter((p) => { const b = PROVIDER_BINARY[p]; return !b || !!which(b); });
}

export function hasV2(projectDir: string) { return existsSync(join(projectDir, ".claude", "claudeclaw", "settings.json")); }

// ── line reader that works with piped stdin (scripted tests) ─────────────────

export class LineReader {
  private lines: string[] = [];
  private waiters: ((l: string | undefined) => void)[] = [];
  private closed = false;
  constructor(input: NodeJS.ReadableStream, private out: NodeJS.WritableStream = process.stdout) {
    const rl = createInterface({ input, terminal: false });
    rl.on("line", (l) => { const w = this.waiters.shift(); if (w) w(l); else this.lines.push(l); });
    rl.on("close", () => { this.closed = true; for (const w of this.waiters.splice(0)) w(undefined); });
  }
  async ask(q: string, def?: string): Promise<string> {
    this.out.write(def !== undefined && def !== "" ? `${q} [${def}]: ` : `${q}: `);
    const l = this.lines.length ? this.lines.shift() : this.closed ? undefined : await new Promise<string | undefined>((r) => this.waiters.push(r));
    if (l === undefined) throw new Error("input ended before the wizard finished");
    if (!process.stdin.isTTY) this.out.write("\n");
    return l.trim() || def || "";
  }
  async yesNo(q: string, def: boolean): Promise<boolean> {
    for (;;) {
      const a = (await this.ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
      if (["y", "yes"].includes(a)) return true;
      if (["n", "no"].includes(a)) return false;
      this.out.write("  please answer y or n\n");
    }
  }
  async choose<T extends string>(q: string, options: readonly T[], def: T): Promise<T> {
    this.out.write(`${q}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}\n`);
    for (;;) {
      const a = await this.ask("choice", String(options.indexOf(def) + 1));
      const n = Number(a);
      const pick = Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : options.find((o) => o === a);
      if (pick) return pick;
      this.out.write("  invalid choice\n");
    }
  }
}

async function askSecret(r: LineReader, label: string, suggested: string): Promise<SecretRef> {
  for (;;) {
    try { return parseSecretRef(await r.ask(`${label} — env var name, file:/path or cmd:<command>`, suggested)); }
    catch (e) { process.stdout.write(`  ${e instanceof Error ? e.message : String(e)}\n`); }
  }
}

/** Interactive wizard. Returns the answers (caller writes the file). */
export async function interactiveAnswers(r: LineReader, available: ProviderName[]): Promise<InitAnswers> {
  const out = process.stdout;
  out.write("\nUniQlaw setup — writes .uniqlaw/settings.json. Secrets are stored as references only.\n\n");
  if (!available.length) throw new Error("no providers available");
  const provider = await r.choose("Agent provider for the main profile:", available, available.includes("claude-tmux") ? "claude-tmux" : available[0]!);
  const model = await r.ask("Model (blank = provider default)", DEFAULT_MODEL[provider] ?? "");
  const kinds = CREDENTIAL_CHOICES[provider];
  const kind = await r.choose("Credential (login = the provider CLI's own login):", kinds, kinds[0]!);
  const f: Record<string, string> = {};
  // collect fields per kind (re-ask on invalid input)
  const field = async (name: string, q: string, def = "") => { f[name] = await r.ask(q, def); };
  let credential: Credential | undefined;
  for (;;) {
    try {
      if (kind === "anthropic-api-key" || kind === "openai-api-key" || kind === "gemini-api-key") {
        const ref = await askSecret(r, "API key", DEFAULT_ENV[kind]!);
        credential = { kind, key: ref } as Credential;
        if (kind === "openai-api-key") { await field("baseUrl", "Base URL (blank = api.openai.com)"); if (f.baseUrl) (credential as { baseUrl?: string }).baseUrl = f.baseUrl; }
      } else if (kind === "openai-compatible") {
        await field("baseUrl", "Base URL (e.g. http://127.0.0.1:11434/v1)");
        const k = await r.ask("API key ref (blank = none)", "");
        credential = buildCredential(kind, { baseUrl: f.baseUrl!, ...(k ? { key: k } : {}) }, provider);
      } else if (kind === "aws") {
        await field("region", "AWS region", "us-east-1"); await field("profile", "AWS profile (blank = default credential chain)");
        credential = buildCredential(kind, f, provider);
      } else if (kind === "gcp") {
        await field("project", "GCP project id"); await field("location", "Location", "us-central1");
        await field("serviceAccountFile", "Service account JSON path (blank = Application Default Credentials)");
        credential = buildCredential(kind, f, provider);
      } else if (kind === "azure") {
        await field("endpoint", "Azure endpoint (https://<resource>.openai.azure.com)"); await field("deployment", "Deployment name (blank = model name)");
        await field("key", "API key ref, or 'entra' for Entra ID", DEFAULT_ENV.azure);
        credential = buildCredential(kind, f, provider);
      } else credential = buildCredential(kind, f, provider);
      break;
    } catch (e) { out.write(`  ${e instanceof Error ? e.message : String(e)}\n`); }
  }

  const platforms: InitAnswers["platforms"] = {};
  for (const name of PLATFORMS) {
    if (!(await r.yesNo(`Connect ${name}?`, name === "telegram"))) continue;
    const secrets: Record<string, SecretRef> = {};
    for (const [key, env] of Object.entries(PLATFORM_SECRETS[name])) secrets[key] = await askSecret(r, `${name} ${key}`, env);
    let ids: string[] = [];
    for (;;) {
      ids = parseIdList(await r.ask(`${name} allowed user ids (comma separated; empty = nobody can talk to the bot)`));
      if (ids.length || await r.yesNo("  No users allowed — the bot will ignore everyone. Continue anyway?", false)) break;
    }
    platforms[name] = { secrets, allowedUserIds: ids };
  }
  const web = await r.yesNo("Enable the local web dashboard (127.0.0.1)?", true);
  const heartbeat = await r.yesNo("Enable the hourly heartbeat (agent checks in on its own)?", false);
  return { provider, model: model || undefined, credential, platforms, web, heartbeat };
}

/** --yes mode: answers from flags. */
export function answersFromFlags(flags: Record<string, string | boolean>, available: ProviderName[]): InitAnswers {
  const provider = String(flags.provider ?? (available.includes("claude-tmux") ? "claude-tmux" : available[0] ?? "pi")) as ProviderName;
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}" (one of ${PROVIDERS.join(", ")})`);
  const model = typeof flags.model === "string" ? flags.model : DEFAULT_MODEL[provider];
  const kind = String(flags.credential ?? CREDENTIAL_CHOICES[provider][0]) as CredKind;
  if (!CREDENTIAL_CHOICES[provider].includes(kind)) throw new Error(`credential "${kind}" is not supported for ${provider} (${CREDENTIAL_CHOICES[provider].join(", ")})`);
  const str = (k: string) => (typeof flags[k] === "string" ? String(flags[k]) : undefined);
  const credential = buildCredential(kind, Object.fromEntries(Object.entries({
    key: str("key"), baseUrl: str("base-url"), region: str("region"), profile: str("aws-profile"),
    project: str("gcp-project"), location: str("location"), serviceAccountFile: str("service-account"),
    endpoint: str("endpoint"), deployment: str("deployment"),
  }).filter(([, v]) => v !== undefined)) as Record<string, string>, provider);

  const platforms: InitAnswers["platforms"] = {};
  for (const name of PLATFORMS) {
    const users = str(`${name}-users`);
    const anySecret = Object.keys(PLATFORM_SECRETS[name]).some((k) => str(`${name}-${kebab(k)}`));
    if (!users && !anySecret && !flags[name]) continue;
    const secrets: Record<string, SecretRef> = {};
    for (const [key, env] of Object.entries(PLATFORM_SECRETS[name])) secrets[key] = parseSecretRef(str(`${name}-${kebab(key)}`) ?? env);
    const ids = users ? parseIdList(users) : [];
    if (!ids.length && !flags["allow-empty"]) throw new Error(`${name}: no --${name}-users given — the bot would ignore everyone (pass --allow-empty to accept)`);
    platforms[name] = { secrets, allowedUserIds: ids };
  }
  return { provider, model, credential, platforms, web: !flags["no-web"], heartbeat: !!flags.heartbeat };
}

function kebab(s: string) { return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`); }

export interface InitResult { settingsPath: string; created: string[]; warnings: string[] }

export function writeSettings(projectDir: string, a: InitAnswers, opts: { force?: boolean } = {}): InitResult {
  const path = join(projectDir, ".uniqlaw", "settings.json");
  if (existsSync(path) && !opts.force) throw new Error(`${path} already exists (use --force to overwrite)`);
  const settings = buildSettings(a);
  mkdirSync(join(projectDir, ".uniqlaw"), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  const warnings: string[] = [];
  const bin = PROVIDER_BINARY[a.provider];
  if (bin && !Bun.which(bin)) warnings.push(`${bin} is not on PATH — install it before \`uniqlaw start\``);
  if (a.provider === "claude-tmux" && !Bun.which("tmux")) warnings.push("tmux is not on PATH — claude-tmux needs it");
  if (a.provider === "agy") warnings.push("agy keeps its Google login in the system keyring: every UniQlaw instance on this machine shares that account");
  for (const [n, p] of Object.entries(a.platforms)) if (!p!.allowedUserIds.length) warnings.push(`${n}: allowedUserIds is empty — the bot ignores everyone until you add ids`);
  return { settingsPath: path, created: scaffoldPrompts(projectDir), warnings };
}
