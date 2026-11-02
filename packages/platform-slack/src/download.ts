// Best-effort attachment download into <attachmentsDir>/<platform>/<scope>/.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, Logger } from "@uniqlaw/core";

export function kindFromMime(mime: string | undefined): Attachment["kind"] {
  if (!mime) return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function extFromName(name: string | undefined): string {
  const m = name ? /\.[a-zA-Z0-9]+$/.exec(name) : null;
  return m ? m[0].toLowerCase() : "";
}

export async function downloadTo(o: {
  url: string; headers?: Record<string, string>; dir: string; platform: string; scope: string; fileName: string;
  kind: Attachment["kind"]; mime?: string; name?: string; durationSec?: number; log: Logger;
}): Promise<Attachment | null> {
  try {
    const res = await fetch(o.url, { headers: o.headers });
    if (!res.ok) { o.log.warn(`${o.platform}: attachment download failed (${res.status})`); return null; }
    const data = new Uint8Array(await res.arrayBuffer());
    const dir = join(o.dir, o.platform, o.scope.replace(/[^a-zA-Z0-9_-]/g, "_"));
    await mkdir(dir, { recursive: true });
    const path = join(dir, o.fileName.replace(/[^a-zA-Z0-9._-]/g, "_"));
    await writeFile(path, data);
    return { kind: o.kind, path, ...(o.mime ? { mime: o.mime } : {}), ...(o.name ? { name: o.name } : {}), ...(o.durationSec !== undefined ? { durationSec: o.durationSec } : {}) };
  } catch (err) {
    o.log.warn(`${o.platform}: attachment download error`, { err: String(err) });
    return null;
  }
}

export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return text ? [text] : [];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + max / 2) end = nl;
    }
    out.push(text.slice(i, end));
    i = end;
    if (text[i] === "\n") i++;
  }
  return out;
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
