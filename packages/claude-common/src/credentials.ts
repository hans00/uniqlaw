// Credential → environment for the claude CLI / Agent SDK child process.
import { resolveSecret, expandHome, type Credential } from "@uniqlaw/core";

export async function claudeEnvForCredential(c: Credential | undefined): Promise<Record<string, string>> {
  if (!c) return {};
  const env: Record<string, string> = {};
  switch (c.kind) {
    case "anthropic-api-key":
      env.ANTHROPIC_API_KEY = await resolveSecret(c.key);
      break;
    case "aws":
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      env.AWS_REGION = c.region;
      if (c.profile) env.AWS_PROFILE = c.profile;
      if (c.accessKey) env.AWS_ACCESS_KEY_ID = await resolveSecret(c.accessKey);
      if (c.secretKey) env.AWS_SECRET_ACCESS_KEY = await resolveSecret(c.secretKey);
      if (c.sessionToken) env.AWS_SESSION_TOKEN = await resolveSecret(c.sessionToken);
      // roleArn: assume-role is expected to be configured in the AWS profile (credential_process / role_arn).
      break;
    case "gcp":
      env.CLAUDE_CODE_USE_VERTEX = "1";
      env.ANTHROPIC_VERTEX_PROJECT_ID = c.project;
      env.CLOUD_ML_REGION = c.location;
      if (c.serviceAccountFile) env.GOOGLE_APPLICATION_CREDENTIALS = expandHome(c.serviceAccountFile);
      break;
    case "azure":
      env.CLAUDE_CODE_USE_FOUNDRY = "1";
      env.ANTHROPIC_FOUNDRY_BASE_URL = c.endpoint;
      if (c.auth.type === "api-key") env.ANTHROPIC_FOUNDRY_API_KEY = await resolveSecret(c.auth.key);
      break;
    case "provider-login":
      if (c.home) env.CLAUDE_CONFIG_DIR = expandHome(c.home);
      break;
    default:
      throw new Error(`credential kind ${(c as Credential).kind} is not supported by Claude adapters`);
  }
  return env;
}

/** Minimal base env for provider children: never the daemon's full environment. */
export function baseChildEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "XDG_RUNTIME_DIR"];
  const env: Record<string, string> = { TERM: "xterm-256color" };
  for (const k of keep) if (src[k]) env[k] = src[k]!;
  return env;
}
