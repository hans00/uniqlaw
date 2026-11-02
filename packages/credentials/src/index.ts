// Credential helpers over core's Credential / SecretRef (docs §10.1).
// Resolved secret values are returned to adapters only; never log them —
// use describeCredential() for anything human-facing.
import { existsSync, readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { expandHome, resolveSecret, type Credential, type SecretRef } from "@uniqlaw/core";

type Env = Record<string, string | undefined>;

/** Credential with every SecretRef replaced by its resolved value. */
export type ResolvedCredential =
  | { kind: "anthropic-api-key"; key: string }
  | { kind: "openai-api-key"; key: string; baseUrl?: string; org?: string }
  | { kind: "gemini-api-key"; key: string }
  | { kind: "openai-compatible"; baseUrl: string; key?: string }
  | { kind: "aws"; region: string; profile?: string; roleArn?: string; accessKey?: string; secretKey?: string; sessionToken?: string }
  | { kind: "gcp"; project: string; location: string; serviceAccountFile?: string; impersonate?: string }
  | { kind: "azure"; endpoint: string; deployment?: string; apiVersion?: string; auth: { type: "api-key"; key: string } | { type: "entra" } }
  | { kind: "provider-login"; provider: string; home?: string };

export interface ResolveOptions {
  env?: Env;
  /** Secret resolver (injectable for tests). */
  resolve?: (ref: SecretRef, env: Env) => Promise<string>;
}

export async function resolveCredential(c: Credential, opts: ResolveOptions = {}): Promise<ResolvedCredential> {
  const env = opts.env ?? process.env;
  const r = (ref: SecretRef) => (opts.resolve ?? resolveSecret)(ref, env);
  const opt = async (ref?: SecretRef) => (ref ? r(ref) : undefined);
  switch (c.kind) {
    case "anthropic-api-key": return { kind: c.kind, key: await r(c.key) };
    case "openai-api-key": return { kind: c.kind, key: await r(c.key), baseUrl: c.baseUrl, org: c.org };
    case "gemini-api-key": return { kind: c.kind, key: await r(c.key) };
    case "openai-compatible": return { kind: c.kind, baseUrl: c.baseUrl, key: await opt(c.key) };
    case "aws": return { kind: c.kind, region: c.region, profile: c.profile, roleArn: c.roleArn,
      accessKey: await opt(c.accessKey), secretKey: await opt(c.secretKey), sessionToken: await opt(c.sessionToken) };
    case "gcp": return { kind: c.kind, project: c.project, location: c.location,
      serviceAccountFile: c.serviceAccountFile ? expandHome(c.serviceAccountFile) : undefined, impersonate: c.impersonate };
    case "azure": return { kind: c.kind, endpoint: c.endpoint, deployment: c.deployment, apiVersion: c.apiVersion,
      auth: c.auth.type === "api-key" ? { type: "api-key", key: await r(c.auth.key) } : { type: "entra" } };
    case "provider-login": return { kind: c.kind, provider: c.provider, home: c.home ? expandHome(c.home) : undefined };
  }
}

function describeRef(ref?: SecretRef): string {
  if (!ref) return "-";
  if ("env" in ref) return `$${ref.env}`;
  if ("file" in ref) return `file:${ref.file}`;
  return `command:${ref.command.split(/\s+/)[0]}…`;
}

/** Human-readable, secret-free description. */
export function describeCredential(c: Credential): string {
  switch (c.kind) {
    case "anthropic-api-key": return `Anthropic API key (${describeRef(c.key)})`;
    case "openai-api-key": return `OpenAI API key (${describeRef(c.key)})${c.baseUrl ? ` @ ${c.baseUrl}` : ""}`;
    case "gemini-api-key": return `Gemini API key (${describeRef(c.key)})`;
    case "openai-compatible": return `OpenAI-compatible endpoint ${c.baseUrl}${c.key ? ` (key ${describeRef(c.key)})` : ""}`;
    case "aws": {
      const how = c.accessKey ? `access key ${describeRef(c.accessKey)}` : c.profile ? `profile ${c.profile}` : "default credential chain";
      return `AWS ${c.region} via ${how}${c.roleArn ? `, assume ${c.roleArn}` : ""}`;
    }
    case "gcp": return `GCP ${c.project}/${c.location} via ${c.serviceAccountFile ? `service account ${c.serviceAccountFile}` : "ADC"}${c.impersonate ? `, impersonating ${c.impersonate}` : ""}`;
    case "azure": return `Azure ${c.endpoint}${c.deployment ? ` (${c.deployment})` : ""} via ${c.auth.type === "api-key" ? `API key ${describeRef(c.auth.key)}` : "Entra ID"}`;
    case "provider-login": return `${c.provider} login${c.home ? ` (${c.home})` : ""}`;
  }
}

// ── validation ─────────────────────────────────────────────────────────────

export interface ValidateOptions extends ResolveOptions {
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  homedir?: string;
}

export interface Validation { ok: boolean; errors: string[]; warnings: string[] }

/** Offline sanity checks: secrets resolve, referenced files exist, profiles are defined. */
export async function validateCredential(c: Credential, opts: ValidateOptions = {}): Promise<Validation> {
  const env = opts.env ?? process.env;
  const exists = opts.fileExists ?? existsSync;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const home = opts.homedir ?? env.HOME ?? osHomedir();
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolve = opts.resolve ?? resolveSecret;
  const checkRef = async (label: string, ref?: SecretRef) => {
    if (!ref) return;
    try {
      const v = await resolve(ref, env);
      if (!v) errors.push(`${label}: ${describeRef(ref)} is empty`);
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  switch (c.kind) {
    case "anthropic-api-key":
    case "gemini-api-key":
      await checkRef("key", c.key);
      break;
    case "openai-api-key":
      await checkRef("key", c.key);
      if (c.baseUrl && !isUrl(c.baseUrl)) errors.push(`baseUrl "${c.baseUrl}" is not a URL`);
      break;
    case "openai-compatible":
      if (!isUrl(c.baseUrl)) errors.push(`baseUrl "${c.baseUrl}" is not a URL`);
      await checkRef("key", c.key);
      break;
    case "aws": {
      if (!c.region) errors.push("region is required");
      if (c.accessKey || c.secretKey) {
        if (!c.accessKey || !c.secretKey) errors.push("accessKey and secretKey must be given together");
        await checkRef("accessKey", c.accessKey);
        await checkRef("secretKey", c.secretKey);
        await checkRef("sessionToken", c.sessionToken);
      } else if (c.profile) {
        const files = [env.AWS_CONFIG_FILE ?? join(home, ".aws", "config"), env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, ".aws", "credentials")];
        const found = files.some((f) => exists(f) && hasAwsProfile(read(f), c.profile!));
        if (!found) errors.push(`AWS profile "${c.profile}" not found in ${files.join(" or ")}`);
      } else if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
        warnings.push("no profile/keys configured: will use ambient AWS_ACCESS_KEY_ID from the daemon environment");
      } else if (env.AWS_WEB_IDENTITY_TOKEN_FILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
        warnings.push("no profile/keys configured: will use the ambient web-identity / container role");
      } else {
        warnings.push("no profile/keys configured: relies on the AWS default chain (SSO cache / instance metadata), which cannot be verified offline");
      }
      if (c.roleArn && !/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(c.roleArn)) errors.push(`roleArn "${c.roleArn}" is not an IAM role ARN`);
      break;
    }
    case "gcp": {
      if (!c.project) errors.push("project is required");
      if (!c.location) errors.push("location is required");
      if (c.serviceAccountFile) {
        const p = expandHome(c.serviceAccountFile);
        if (!exists(p)) errors.push(`service account file ${p} does not exist`);
      } else {
        const adc = env.GOOGLE_APPLICATION_CREDENTIALS
          ?? join(env.CLOUDSDK_CONFIG ?? join(home, ".config", "gcloud"), "application_default_credentials.json");
        if (!exists(adc)) errors.push(`no Application Default Credentials found at ${adc} — run \`gcloud auth application-default login\` or set serviceAccountFile`);
      }
      break;
    }
    case "azure": {
      if (!isUrl(c.endpoint)) errors.push(`endpoint "${c.endpoint}" is not a URL`);
      if (c.auth.type === "api-key") await checkRef("auth.key", c.auth.key);
      else if (!(env.AZURE_CLIENT_ID && (env.AZURE_TENANT_ID || env.AZURE_FEDERATED_TOKEN_FILE))) {
        warnings.push("Entra ID: no AZURE_CLIENT_ID/AZURE_TENANT_ID in the environment; DefaultAzureCredential will try az CLI / managed identity");
      }
      break;
    }
    case "provider-login":
      if (c.home && !exists(expandHome(c.home))) warnings.push(`login home ${c.home} does not exist yet (log in once with the provider's CLI)`);
      break;
  }
  return { ok: errors.length === 0, errors, warnings };
}

function isUrl(s: string) { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } }

function hasAwsProfile(ini: string, profile: string): boolean {
  const esc = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[(?:profile\\s+)?${esc}\\]\\s*$`, "m").test(ini);
}

// ── env mappers ────────────────────────────────────────────────────────────

/** Generic provider-neutral env for a resolved credential (OpenAI/Anthropic/Gemini SDKs,
 *  AWS SDK, Google ADC, Azure OpenAI). Adapters may layer their own specifics on top. */
export function envFor(c: ResolvedCredential): Record<string, string> {
  const e: Record<string, string> = {};
  const set = (k: string, v?: string) => { if (v) e[k] = v; };
  switch (c.kind) {
    case "anthropic-api-key": set("ANTHROPIC_API_KEY", c.key); break;
    case "openai-api-key": set("OPENAI_API_KEY", c.key); set("OPENAI_BASE_URL", c.baseUrl); set("OPENAI_ORG_ID", c.org); break;
    case "gemini-api-key": set("GEMINI_API_KEY", c.key); set("GOOGLE_API_KEY", c.key); break;
    case "openai-compatible": set("OPENAI_BASE_URL", c.baseUrl); set("OPENAI_API_KEY", c.key ?? "unused"); break;
    case "aws":
      set("AWS_REGION", c.region); set("AWS_DEFAULT_REGION", c.region); set("AWS_PROFILE", c.profile);
      set("AWS_ACCESS_KEY_ID", c.accessKey); set("AWS_SECRET_ACCESS_KEY", c.secretKey); set("AWS_SESSION_TOKEN", c.sessionToken);
      set("AWS_ROLE_ARN", c.roleArn);
      break;
    case "gcp":
      set("GOOGLE_CLOUD_PROJECT", c.project); set("GCLOUD_PROJECT", c.project); set("GOOGLE_CLOUD_LOCATION", c.location);
      set("GOOGLE_APPLICATION_CREDENTIALS", c.serviceAccountFile);
      set("CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", c.impersonate);
      break;
    case "azure":
      set("AZURE_OPENAI_BASE_URL", c.endpoint); set("AZURE_OPENAI_ENDPOINT", c.endpoint);
      set("AZURE_OPENAI_API_VERSION", c.apiVersion); set("AZURE_OPENAI_DEPLOYMENT", c.deployment);
      if (c.auth.type === "api-key") set("AZURE_OPENAI_API_KEY", c.auth.key);
      break;
    case "provider-login": break;
  }
  return e;
}

// ── pi-ai mapping ──────────────────────────────────────────────────────────

/** pi-ai provider ids (checked against @earendil-works/pi-ai 1.4 catalogs). */
export const PI_PROVIDER_FOR_KIND: Record<Exclude<ResolvedCredential["kind"], "provider-login" | "openai-compatible">, string> = {
  "anthropic-api-key": "anthropic",
  "openai-api-key": "openai",
  "gemini-api-key": "google",
  gcp: "google-vertex",
  aws: "amazon-bedrock",
  azure: "azure",
};

/** Synthetic provider id UniQlaw registers for openai-compatible endpoints. */
export const PI_COMPAT_PROVIDER = "uniqlaw-compat";

export interface PiAuth {
  /** pi-ai provider id the credential serves. */
  provider: string;
  /** Credential to put in a per-session in-memory CredentialStore (pi-ai `ApiKeyCredential`). */
  credential?: { type: "api_key"; key?: string; env?: Record<string, string> };
  /** provider-login: use this pi auth.json (OAuth logins) instead. */
  authPath?: string;
  /** openai-compatible: register a custom provider with this base URL. */
  compat?: { baseUrl: string; apiKey?: string };
  /** Applied to the pi Model object. pi-ai's OpenAI client only takes base URL / extra headers
   *  from the model (`new OpenAI({ baseURL: model.baseUrl, defaultHeaders: { ...model.headers } })`,
   *  pi-ai 1.4 api/openai-responses.js); it reads no OPENAI_BASE_URL / OPENAI_ORG_ID env. */
  modelOverrides?: { baseUrl?: string; headers?: Record<string, string> };
  /** Merged into every request's `options.env` for this session. Needed where pi-ai only reads a
   *  value from the request/ambient env, not from the stored credential: Bedrock's resolve() looks up
   *  AWS_ACCESS_KEY_ID/… via ctx.env (ambient + request env) and only takes AWS_PROFILE from the
   *  stored credential (pi-ai 1.4 providers/amazon-bedrock.js). */
  requestEnv?: Record<string, string>;
}

/** Credential options pi-ai 1.4 cannot honour — refuse loudly instead of silently ignoring them. */
export class UnsupportedCredentialError extends Error {}

/** Map a resolved credential to pi-ai auth. Values in `credential.env` are provider-scoped
 *  (pi reads them before process.env), so profiles never leak into each other. */
export function piAuthFor(c: ResolvedCredential): PiAuth {
  switch (c.kind) {
    case "anthropic-api-key":
    case "gemini-api-key":
      return { provider: PI_PROVIDER_FOR_KIND[c.kind], credential: { type: "api_key", key: c.key } };
    case "openai-api-key": {
      const headers = c.org ? { "OpenAI-Organization": c.org } : undefined;
      return { provider: PI_PROVIDER_FOR_KIND[c.kind], credential: { type: "api_key", key: c.key },
        ...(c.baseUrl || headers ? { modelOverrides: { ...(c.baseUrl ? { baseUrl: c.baseUrl.replace(/\/+$/, "") } : {}), ...(headers ? { headers } : {}) } } : {}) };
    }
    case "openai-compatible":
      return { provider: PI_COMPAT_PROVIDER, compat: { baseUrl: c.baseUrl, apiKey: c.key } };
    case "aws":
      // pi-ai reads AWS_REGION/AWS_DEFAULT_REGION, AWS_PROFILE, AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN
      // from the scoped env (api/bedrock-converse-stream.js getConfiguredBedrockRegion /
      // getConfiguredBedrockCredentials). It has no role-assumption option.
      if (c.roleArn) throw new UnsupportedCredentialError("aws.roleArn is not supported by the pi provider (pi-ai has no assume-role option). Put role_arn/source_profile in an ~/.aws/config profile and set aws.profile instead.");
      {
        const env = stripEmpty({
          AWS_REGION: c.region, AWS_DEFAULT_REGION: c.region, AWS_PROFILE: c.profile,
          AWS_ACCESS_KEY_ID: c.accessKey, AWS_SECRET_ACCESS_KEY: c.secretKey, AWS_SESSION_TOKEN: c.sessionToken,
        });
        return { provider: "amazon-bedrock", credential: { type: "api_key", ...(c.profile ? { env: { AWS_PROFILE: c.profile } } : {}) }, requestEnv: env };
      }
    case "gcp":
      // pi-ai: project = GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT, location = GOOGLE_CLOUD_LOCATION,
      // googleAuthOptions = { keyFilename: GOOGLE_APPLICATION_CREDENTIALS } (api/google-vertex.js).
      if (c.impersonate) throw new UnsupportedCredentialError("gcp.impersonate is not supported by the pi provider (pi-ai passes only keyFilename to google-auth). Use an impersonated ADC file (gcloud auth application-default login --impersonate-service-account=…) as serviceAccountFile instead.");
      return { provider: "google-vertex", credential: { type: "api_key", env: stripEmpty({
        GOOGLE_CLOUD_PROJECT: c.project, GOOGLE_CLOUD_LOCATION: c.location, GOOGLE_APPLICATION_CREDENTIALS: c.serviceAccountFile,
      }) } };
    case "azure":
      // pi-ai's Azure provider requires an API key (`new AzureOpenAI({ apiKey })`, throws without one;
      // api/azure-openai-responses.js) — no Entra ID / token provider.
      if (c.auth.type !== "api-key") throw new UnsupportedCredentialError("azure Entra ID auth is not supported by the pi provider (pi-ai's Azure client takes only an API key). Use auth.type \"api-key\".");
      return { provider: "azure", credential: { type: "api_key",
        key: c.auth.type === "api-key" ? c.auth.key : undefined,
        // The deployment name map needs the model id; provider-pi adds it (azureDeploymentMap()).
        env: stripEmpty({ AZURE_OPENAI_BASE_URL: c.endpoint, AZURE_OPENAI_API_VERSION: c.apiVersion }) } };
    case "provider-login":
      return { provider: c.provider === "pi" ? "" : c.provider, authPath: c.home ? join(c.home, "auth.json") : undefined };
  }
}

/** `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` entry mapping a pi model id to an Azure deployment. */
export function azureDeploymentMap(modelId: string, deployment?: string): Record<string, string> {
  return deployment && deployment !== modelId ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${modelId}=${deployment}` } : {};
}

function stripEmpty(o: Record<string, string | undefined>): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v) r[k] = v;
  return r;
}
