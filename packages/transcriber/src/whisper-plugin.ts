// Local speech-to-text with whisper.cpp through @fugood/whisper.node (optional dependency).
// Audio is decoded with ffmpeg to 16 kHz mono PCM; one model context is loaded on first use and
// requests run one at a time.
import { isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { definePlugin, type Logger, type Transcriber } from "@uniqlaw/core";
import { decodeToPcm16k } from "./ffmpeg.ts";

export const whisperConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** ggml model file (e.g. ggml-base.bin, ggml-large-v3-turbo-q5_0.bin from huggingface.co/ggerganov/whisper.cpp); relative to the project. */
  model: z.string().min(1),
  useGpu: z.boolean().default(true),
  /** Native build to load: default (CPU, Metal on Apple), vulkan or cuda. */
  variant: z.enum(["default", "vulkan", "cuda"]).default("default"),
  ffmpeg: z.string().default("ffmpeg"),
});

interface WhisperCtx {
  transcribeData(pcm: ArrayBuffer, o?: { language?: string }): { stop(): Promise<void>; promise: Promise<{ result: string; isAborted: boolean }> };
  release(): Promise<void>;
}
type WhisperModule = { initWhisper(o: { filePath: string; useGpu?: boolean }, variant?: string): Promise<WhisperCtx> };

/** Whether the optional native module can be loaded here (for `uniqlaw doctor`). */
export async function whisperModuleAvailable(): Promise<boolean> {
  try { await import("@fugood/whisper.node" as string); return true; } catch { return false; }
}

export class WhisperTranscriber implements Transcriber {
  private ctx?: Promise<WhisperCtx>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: { model: string; useGpu: boolean; variant: string; ffmpeg: string; log: Logger },
    private readonly load: () => Promise<WhisperModule> = () => import("@fugood/whisper.node" as string) as Promise<WhisperModule>) {}

  private context(): Promise<WhisperCtx> {
    this.ctx ??= (async () => {
      if (!existsSync(this.o.model)) throw new Error(`whisper model not found: ${this.o.model}`);
      let mod: WhisperModule;
      try { mod = await this.load(); } catch (e) {
        throw new Error(`@fugood/whisper.node is not installed or has no build for this platform (bun install in the UniQlaw checkout): ${e instanceof Error ? e.message : String(e)}`);
      }
      const started = Date.now();
      const ctx = await mod.initWhisper({ filePath: this.o.model, useGpu: this.o.useGpu }, this.o.variant === "default" ? undefined : this.o.variant);
      this.o.log.info("whisper model loaded", { model: this.o.model, ms: Date.now() - started });
      return ctx;
    })().catch((e) => { this.ctx = undefined; throw e; });
    return this.ctx;
  }

  transcribe(input: { path: string; language?: string; signal?: AbortSignal }): Promise<string> {
    const run = async () => {
      const pcm = await decodeToPcm16k(input.path, this.o.ffmpeg, input.signal);
      const ctx = await this.context();
      const job = ctx.transcribeData(pcm, { language: input.language ?? "auto" });
      const onAbort = () => void job.stop();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try { return (await job.promise).result.trim(); } finally { input.signal?.removeEventListener("abort", onAbort); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async stop() {
    const ctx = await this.ctx?.catch(() => undefined);
    this.ctx = undefined;
    await ctx?.release();
  }
}

export default definePlugin({
  kind: "transcriber",
  name: "whisper",
  configSchema: whisperConfigSchema,
  create(ctx, cfg) {
    const model = isAbsolute(cfg.model) ? cfg.model : resolve(ctx.projectDir, cfg.model);
    return new WhisperTranscriber({ model, useGpu: cfg.useGpu, variant: cfg.variant, ffmpeg: cfg.ffmpeg, log: ctx.log.child("whisper") });
  },
});
