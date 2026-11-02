// Credential references (docs §10.1). UniQlaw stores where to get secrets, never the values.
export type SecretRef = { env: string } | { file: string } | { command: string };

export type Credential =
  | { kind: "anthropic-api-key"; key: SecretRef }
  | { kind: "openai-api-key"; key: SecretRef; baseUrl?: string; org?: string }
  | { kind: "gemini-api-key"; key: SecretRef }
  | { kind: "openai-compatible"; baseUrl: string; key?: SecretRef }
  | { kind: "aws"; region: string; profile?: string; roleArn?: string;
      accessKey?: SecretRef; secretKey?: SecretRef; sessionToken?: SecretRef }
  | { kind: "gcp"; project: string; location: string; serviceAccountFile?: string; impersonate?: string }
  | { kind: "azure"; endpoint: string; deployment?: string; apiVersion?: string;
      auth: { type: "api-key"; key: SecretRef } | { type: "entra" } }
  | { kind: "provider-login"; provider: string; home?: string };

export async function resolveSecret(ref: SecretRef, env: Record<string, string | undefined> = process.env): Promise<string> {
  if ("env" in ref) {
    const v = env[ref.env];
    if (!v) throw new Error(`secret env var ${ref.env} is not set`);
    return v;
  }
  if ("file" in ref) return (await Bun.file(expandHome(ref.file)).text()).trim();
  const p = Bun.spawn(["sh", "-c", ref.command], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0) throw new Error(`secret command failed: ${ref.command}`);
  return out;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? `${process.env.HOME}/${p.slice(2)}` : p;
}
