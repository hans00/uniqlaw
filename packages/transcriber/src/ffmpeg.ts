// Decode any audio file (Telegram/Discord OGG-Opus voice notes, m4a, mp3, …) to what whisper.cpp
// takes: 16 kHz mono signed 16-bit PCM. whisper.cpp's own reader (miniaudio) can't open OGG/Opus.
export async function decodeToPcm16k(path: string, ffmpeg = "ffmpeg", signal?: AbortSignal): Promise<ArrayBuffer> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([ffmpeg, "-nostdin", "-loglevel", "error", "-i", path, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000", "-"],
      { stdout: "pipe", stderr: "pipe", ...(signal ? { signal } : {}) });
  } catch (e) {
    throw new Error(`cannot run ${ffmpeg} (install ffmpeg or set plugins.whisper.ffmpeg): ${e instanceof Error ? e.message : String(e)}`);
  }
  const [pcm, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).arrayBuffer(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err.trim().slice(0, 300)}`);
  return pcm;
}
