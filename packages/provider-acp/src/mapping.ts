// Pure helpers for the generic ACP adapter.
import type { Attachment, PermissionDecision, ProviderCapabilities } from "@uniqlaw/core";

export type AcpPermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string };

/** UniQlaw decision → ACP permission option id (falls back by kind prefix). */
export function pickOption(options: AcpPermissionOption[], d: PermissionDecision): string | undefined {
  // scope "once" (an approval-judge allow) must never grant more than this call: no fallback to allow_always.
  if (d.behavior === "allow" && d.scope === "once") return options.find((x) => x.kind === "allow_once")?.optionId;
  const want = d.behavior === "allow" ? (d.scope === "session" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) : ["reject_once", "reject_always"];
  for (const k of want) { const o = options.find((x) => x.kind === k); if (o) return o.optionId; }
  const prefix = d.behavior === "allow" ? "allow" : "reject";
  return options.find((x) => String(x.kind).startsWith(prefix))?.optionId;
}

export function errorCode(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e ?? "");
  if (/rate.?limit|too many requests|\b429\b/i.test(msg)) return "rate_limit";
  if (/quota|usage limit|insufficient.?(credit|balance|funds)|billing/i.test(msg)) return "usage_limit";
  if (/unauthori[sz]ed|auth(entication)? required|invalid api key|\b401\b/i.test(msg)) return "auth";
  return msg.slice(0, 300);
}

/** stopReason → turn_end reason/error. */
export function stopReasonToEnd(stop: string | undefined): { reason: "done" | "interrupted" | "error"; error?: string } {
  switch (stop) {
    case "cancelled": return { reason: "interrupted" };
    case "refusal": return { reason: "error", error: "refusal" };
    default: return { reason: "done" }; // end_turn, max_tokens, max_turn_requests
  }
}

export async function promptBlocks(text: string, attachments: Attachment[], caps: { image?: boolean; audio?: boolean }): Promise<Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = [{ type: "text", text }];
  for (const a of attachments) {
    const mime = a.mime ?? (a.kind === "image" ? "image/png" : "application/octet-stream");
    if (a.kind === "image" && caps.image) {
      blocks.push({ type: "image", mimeType: mime, data: Buffer.from(await Bun.file(a.path).arrayBuffer()).toString("base64"), uri: `file://${a.path}` });
    } else if ((a.kind === "audio" || a.kind === "voice") && caps.audio) {
      blocks.push({ type: "audio", mimeType: mime, data: Buffer.from(await Bun.file(a.path).arrayBuffer()).toString("base64") });
    } else {
      blocks.push({ type: "resource_link", name: a.name ?? a.path.split("/").pop() ?? "file", uri: `file://${a.path}`, mimeType: mime });
    }
  }
  return blocks;
}

/** Elicitation reply: a single-field form takes the raw value; otherwise expect JSON. */
export function elicitationContent(schema: { properties?: Record<string, unknown> } | undefined, value: string): Record<string, unknown> {
  const keys = Object.keys(schema?.properties ?? {});
  if (keys.length === 1) return { [keys[0]!]: value };
  try { const v = JSON.parse(value); if (v && typeof v === "object") return v as Record<string, unknown>; } catch {}
  return keys.length ? { [keys[0]!]: value } : { value };
}

export interface AcpProfileOptions {
  /** "concurrent-prompt": steer by sending a second session/prompt mid-turn (verified for opencode acp). */
  steer?: "concurrent-prompt" | false;
  modelSwitch?: "live" | "spawn";
  agentEnv?: Record<string, string>;
  userConfig?: boolean;
  userData?: boolean;
}

export function capabilitiesFor(o: { steer: boolean; modelSwitch: "live" | "spawn"; shareProcess: boolean }): ProviderCapabilities {
  return {
    streaming: "token",
    interrupt: true,
    steer: o.steer,
    resume: "native",
    denyEndsTurn: false,
    modelSwitch: o.modelSwitch,
    permissionCallback: true,
    // ACP says MCP is per session, but agents can't be trusted with it (opencode acp leaks).
    mcp: o.shareProcess ? "per-session" : "per-process",
    nativeTools: false,
    attachments: ["image", "file", "audio"],
    slashCommands: true,
  };
}

/** opencode `--print-logs` line → {sessionId, error code} for fatal (non-retrying) model errors. */
export function opencodeLogError(line: string): { sessionId: string; code: string } | undefined {
  if (!/level=ERROR/.test(line) || !/message="stream error"/.test(line) || /small=true/.test(line)) return undefined;
  const sid = line.match(/session\.id=(\S+)/)?.[1];
  if (!sid) return undefined;
  const code = errorCode(line);
  // Only errors that won't fix themselves within the turn; transient ones opencode retries.
  if (code !== "usage_limit" && code !== "auth" && code !== "rate_limit" && !/AI_RetryError|Failed after \d+ attempts/.test(line)) return undefined;
  return { sessionId: sid, code: code === "usage_limit" || code === "auth" || code === "rate_limit" ? code : "rate_limit" };
}
