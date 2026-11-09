// transcribe-api against a local fake endpoint; whisper with a fake whisper.node module (and real
// ffmpeg when installed); a real whisper.cpp run when UNIQLAW_WHISPER_MODEL points at a ggml model.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@uniqlaw/core";
import apiPlugin from "../src/api-plugin.ts";
import { WhisperTranscriber } from "../src/whisper-plugin.ts";

let dir: string;
let ogg: string;
const ffmpeg = Bun.which("ffmpeg");
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uq-stt-"));
  ogg = join(dir, "voice.oga");
  if (ffmpeg) {
    // 1 s of a 440 Hz tone, OGG/Opus like a Telegram voice note
    const p = Bun.spawn([ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "ogg", ogg]);
    await p.exited;
  } else await Bun.write(ogg, "not really audio");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("transcribe-api: multipart upload with model/language, bearer key, .oga renamed to .ogg; errors surface", async () => {
  const seen: { auth: string | null; fields: Record<string, string>; file?: { name: string; size: number } }[] = [];
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const form = await req.formData();
    const fields: Record<string, string> = {};
    let file: { name: string; size: number } | undefined;
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
      else file = { name: (v as File).name, size: (v as File).size };
    }
    seen.push({ auth: req.headers.get("authorization"), fields, ...(file ? { file } : {}) });
    if (fields.model === "bad") return Response.json({ error: { message: "model not found" } }, { status: 404 });
    return Response.json({ text: "  hello there  " });
  } });
  process.env.UQ_TEST_STT_KEY = "sk-test";
  const t = await apiPlugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    apiPlugin.configSchema.parse({ baseUrl: `http://127.0.0.1:${srv.port}/v1/`, key: { env: "UQ_TEST_STT_KEY" }, model: "whisper-large-v3" }));
  expect(await t.transcribe({ path: ogg, language: "zh" })).toBe("hello there");
  expect(seen[0]).toMatchObject({ auth: "Bearer sk-test", fields: { model: "whisper-large-v3", language: "zh", response_format: "json" }, file: { name: "voice.ogg" } });
  const bad = await apiPlugin.create({ log: silentLogger, instanceId: "t", projectDir: dir, stateDir: dir, timezone: "UTC" },
    apiPlugin.configSchema.parse({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, model: "bad" }));
  await expect(bad.transcribe({ path: ogg })).rejects.toThrow("404: model not found");
  expect(seen[1]!.auth).toBeNull();
  srv.stop(true);
});

test.skipIf(!ffmpeg)("whisper: ffmpeg decodes to 16 kHz mono PCM, one context, requests serialized; missing module/model is a clear error", async () => {
  const model = join(dir, "fake-model.bin");
  await Bun.write(model, "x");
  let inits = 0;
  let active = 0;
  let maxActive = 0;
  const lens: number[] = [];
  const fakeModule = async () => ({
    initWhisper: async (o: { filePath: string }) => {
      inits++;
      expect(o.filePath).toBe(model);
      return {
        transcribeData: (pcm: ArrayBuffer, opts?: { language?: string }) => ({ stop: async () => {}, promise: (async () => {
          active++; maxActive = Math.max(maxActive, active);
          lens.push(pcm.byteLength);
          await Bun.sleep(20);
          active--;
          return { result: ` lang=${opts?.language} `, isAborted: false };
        })() }),
        release: async () => {},
      };
    },
  });
  const w = new WhisperTranscriber({ model, useGpu: false, variant: "default", ffmpeg: ffmpeg!, log: silentLogger }, fakeModule);
  const [a, b] = await Promise.all([w.transcribe({ path: ogg, language: "en" }), w.transcribe({ path: ogg })]);
  expect([a, b]).toEqual(["lang=en", "lang=auto"]);
  expect(inits).toBe(1);
  expect(maxActive).toBe(1);
  // ~1 s at 16 kHz × 2 bytes (Opus may pad a little)
  for (const n of lens) expect(Math.abs(n - 32_000)).toBeLessThan(4_000);
  await w.stop();

  const noModule = new WhisperTranscriber({ model, useGpu: false, variant: "default", ffmpeg: ffmpeg!, log: silentLogger }, async () => { throw new Error("Cannot find module"); });
  await expect(noModule.transcribe({ path: ogg })).rejects.toThrow("@fugood/whisper.node is not installed");
  const noModel = new WhisperTranscriber({ model: join(dir, "nope.bin"), useGpu: false, variant: "default", ffmpeg: ffmpeg!, log: silentLogger }, fakeModule);
  await expect(noModel.transcribe({ path: ogg })).rejects.toThrow("whisper model not found");
  const noFfmpeg = new WhisperTranscriber({ model, useGpu: false, variant: "default", ffmpeg: join(dir, "no-ffmpeg"), log: silentLogger }, fakeModule);
  await expect(noFfmpeg.transcribe({ path: ogg })).rejects.toThrow("cannot run");
});

const realModel = process.env.UNIQLAW_WHISPER_MODEL;
const espeak = Bun.which("espeak-ng");
test.skipIf(!realModel || !ffmpeg || !espeak)("whisper (real whisper.cpp): transcribes a synthesized OGG voice note", async () => {
  const wav = join(dir, "speech.wav");
  const voice = join(dir, "speech.ogg");
  await Bun.spawn([espeak!, "-w", wav, "Hello, this is a test."]).exited;
  await Bun.spawn([ffmpeg!, "-loglevel", "error", "-i", wav, "-c:a", "libopus", voice]).exited;
  const w = new WhisperTranscriber({ model: realModel!, useGpu: false, variant: "default", ffmpeg: ffmpeg!, log: silentLogger });
  const text = await w.transcribe({ path: voice, language: "en" });
  await w.stop();
  expect(text.toLowerCase()).toContain("test");
}, 120_000);
