// Speech-to-text through an OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq,
// a local faster-whisper / whisper.cpp server, …). The file is uploaded as is.
import { basename } from "node:path";
import { z } from "zod";
import { definePlugin, resolveSecret, type SecretRef, type Transcriber } from "@uniqlaw/core";

const secretRef = z.union([z.object({ env: z.string() }), z.object({ file: z.string() }), z.object({ command: z.string() })]);

export const apiConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  /** API key by reference; omit for local servers without auth. */
  key: secretRef.optional(),
  model: z.string().default("whisper-1"),
  timeoutSec: z.number().positive().default(120),
});

export class ApiTranscriber implements Transcriber {
  constructor(private readonly o: { baseUrl: string; key?: string; model: string; timeoutMs: number }) {}

  async transcribe(input: { path: string; mime?: string; language?: string; signal?: AbortSignal }): Promise<string> {
    const form = new FormData();
    const file = Bun.file(input.path);
    // OpenAI picks the decoder from the file name: Telegram voice notes (.oga) must look like .ogg.
    const name = basename(input.path).replace(/\.oga$/i, ".ogg");
    form.append("file", input.mime ? new File([await file.arrayBuffer()], name, { type: input.mime }) : file, name);
    form.append("model", this.o.model);
    form.append("response_format", "json");
    if (input.language) form.append("language", input.language);
    const signals = [AbortSignal.timeout(this.o.timeoutMs), ...(input.signal ? [input.signal] : [])];
    const res = await fetch(`${this.o.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST", body: form, headers: this.o.key ? { authorization: `Bearer ${this.o.key}` } : {}, signal: AbortSignal.any(signals),
    });
    const body = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (!res.ok || typeof body?.text !== "string") throw new Error(`transcription API ${res.status}: ${body?.error?.message ?? "unexpected response"}`);
    return body.text.trim();
  }
}

export default definePlugin({
  kind: "transcriber",
  name: "transcribe-api",
  configSchema: apiConfigSchema,
  async create(_ctx, cfg) {
    const key = cfg.key ? await resolveSecret(cfg.key as SecretRef) : undefined;
    return new ApiTranscriber({ baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: cfg.timeoutSec * 1000, ...(key ? { key } : {}) });
  },
});
