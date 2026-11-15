// MCP auto-recovery and pane health for claude-tmux (docs §11.4).
//
// Claude Code does not reconnect an HTTP MCP server after an outage longer than its few quick retries (probed on
// 2.1.325: 60 s down → "✘ failed" for good; 2 s down → still "✔" but its event-stream is gone). A daemon restart is
// such an outage for every reattached session. The only reliable fix from outside is the TUI itself:
//   /mcp → select the server → select "Reconnect" → "Reconnected to <server>." (the dialog closes on its own),
// verified by the gateway seeing a fresh `initialize`. Fixtures: test/fixtures/mcp/.
//
// Rules for driving it: start only at an idle prompt with an empty input box; look at the pane again right before
// every key; select menu entries by their text with the cursor checked after every move (never a blind count of
// Down presses: "Reconnect" sits between "Authenticate" and "Disable"); on anything unexpected press Esc until the
// pane is back at an empty prompt, never leave it inside a menu.
import type { Tmux } from "./tmux.ts";
import { parsePermissionDialog } from "./dialogs.ts";
import { isReady, looksActivelyBusy, STARTUP_PROMPTS } from "./pane.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text typed into the input box, from an ANSI capture (`tmux capture-pane -e`): "" when empty or showing only a dim
 *  suggestion/placeholder (`❯ Try "edit…"`, `❯ call it again`), undefined when there is no input box. */
export function inputBoxText(ansiPane: string): string | undefined {
  const lines = ansiPane.split("\n");
  const plain = lines.map((l) => l.replace(ANSI, ""));
  // The input box: a `❯` line between two long rules (hasReadyPrompt's shape); take the last one on screen.
  for (let i = plain.length - 2; i >= 1; i--) {
    if (!/^\s*❯/.test(plain[i]!) || !/─{20,}/.test(plain[i - 1]!) || !/─{20,}/.test(plain[i + 1]!)) continue;
    const raw = lines[i]!;
    const at = raw.indexOf("❯");
    // Drop dim runs (SGR 2 … until a reset / normal intensity): that is placeholder text, not input.
    let rest = raw.slice(at + 1);
    rest = rest.replace(/\x1b\[2m[\s\S]*?(?=\x1b\[(?:0|22)?m|$)/g, "");
    return rest.replace(ANSI, "").replace(/[\s ]+/g, " ").trim();
  }
  return undefined;
}

/** The `/mcp` server list ("Manage MCP servers"). */
export function isMcpList(pane: string): boolean {
  return /Manage MCP servers/.test(pane) && /to navigate/.test(pane);
}

/** A server's detail menu in `/mcp` ("Uniqlaw MCP Server … ❯ 1. View tools / Authenticate / Reconnect / Disable"). */
export function isMcpDetail(pane: string, server?: string): boolean {
  const name = server ? escRe(server) : "\\S+";
  return new RegExp(`^\\s*${name} MCP Server\\s*$`, "im").test(pane) && /^\s*Status:/m.test(pane)
    && /\b(Reconnect|Disable|Enable)\b/.test(pane) && /to navigate/.test(pane);
}

/** Any part of the `/mcp` dialog is open. */
export function isMcpDialog(pane: string): boolean { return isMcpList(pane) || isMcpDetail(pane); }

/** How many times the pane shows a reconnect result for `server`. */
export function mcpResultCounts(pane: string, server: string): { ok: number; failed: number } {
  const n = escRe(server);
  return {
    ok: (pane.match(new RegExp(`Reconnected to ${n}\\.`, "g")) ?? []).length,
    failed: (pane.match(new RegExp(`Failed to reconnect to ${n}\\b`, "g")) ?? []).length,
  };
}

/** Cursor (`❯`) and target line indexes inside an open dialog (below its top edge `▔▔▔`, so the scrollback's
 *  `❯ /mcp` prompt lines don't count); -1 when not on screen. Side borders (`│`) are ignored. */
export function menuCursor(pane: string, target: RegExp): { cursor: number; target: number } {
  const lines = pane.split("\n").map((l) => l.replace(/^\s*[│┃|]/, "").replace(/[│┃|]\s*$/, ""));
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*▔{10,}/.test(lines[i]!)) { top = i; break; }
  let cursor = -1, tgt = -1;
  for (let i = top + 1; i < lines.length; i++) {
    if (cursor < 0 && /^\s*❯\s*\S/.test(lines[i]!)) cursor = i;
    if (tgt < 0 && target.test(lines[i]!)) tgt = i;
  }
  return { cursor, target: tgt };
}

/** What keeps a pane from taking input, if anything: a startup prompt (by label), a permission/question dialog, the
 *  `/mcp` dialog, or another menu/modal. undefined = nothing recognisable (ready, busy, or plain output). */
export type PaneBlocker =
  | { kind: "startup"; label: string }
  | { kind: "permission" }
  | { kind: "mcp-dialog" }
  | { kind: "modal"; label: string };

export function classifyBlocker(pane: string): PaneBlocker | undefined {
  const startup = STARTUP_PROMPTS.find((p) => p.match(pane));
  if (startup) return { kind: "startup", label: startup.label };
  if (isMcpDialog(pane)) return { kind: "mcp-dialog" };
  if (isReady(pane)) return undefined;
  const d = parsePermissionDialog(pane);
  if (d && d.kind !== "login") return { kind: "permission" };
  const tail = pane.split("\n").slice(-12).join("\n");
  if (/(to navigate|Esc to (cancel|back|close|exit)|Enter to (confirm|select))/i.test(tail)) {
    const title = pane.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => !/^[▔─━]+$/.test(l)) ?? "menu";
    return { kind: "modal", label: title.slice(0, 60) };
  }
  return undefined;
}

export type ReconnectOutcome =
  | { ok: true; outcome: "reconnected"; detail: string }
  | { ok: false; outcome: "skipped" | "aborted" | "failed"; detail: string };

export interface ReconnectDeps {
  tmux: Tmux;
  name: string;
  server: string;
  /** Did the gateway see this session (re)initialize at or after `since`? */
  verify: (since: number) => boolean;
  keyDelayMs?: number;
  /** How long to wait for each screen / the result / the gateway. */
  stepTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** Aborted (daemon stopping): stop before the next key and go back to an empty prompt. */
  signal?: AbortSignal;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

class Abort extends Error {}

/**
 * Drive `/mcp` → server → Reconnect in an idle claude pane and check it worked. The caller guarantees nothing else
 * types into the pane meanwhile (ClaudeTmuxSession holds input). Never leaves the pane inside a menu.
 */
export async function reconnectMcp(d: ReconnectDeps): Promise<ReconnectOutcome> {
  const delay = d.keyDelayMs ?? 150;
  const stepTimeout = d.stepTimeoutMs ?? 4000;
  const resultTimeout = d.resultTimeoutMs ?? 15_000;
  const cap = () => d.tmux.capture(d.name);
  const capAnsi = () => d.tmux.captureAnsi(d.name);

  /** The pane as it is right now must be idle at an empty prompt. */
  const idleEmpty = async (): Promise<string | undefined> => {
    const [pane, ansi] = [await cap(), await capAnsi()];
    if (looksActivelyBusy(pane)) return "busy";
    if (!isReady(pane)) return "not at the prompt";
    if (classifyBlocker(pane)) return "a dialog is open";
    const text = inputBoxText(ansi);
    if (text === undefined) return "no input box";
    if (text !== "") return "the input box is not empty";
    return undefined;
  };
  const waitFor = async (pred: (pane: string) => boolean, ms: number): Promise<string | undefined> => {
    const until = Date.now() + ms;
    for (;;) {
      if (d.signal?.aborted) throw new Abort("stopped: the daemon is shutting down");
      const pane = await cap();
      if (pred(pane)) return pane;
      if (Date.now() >= until) return undefined;
      await sleep(150);
    }
  };
  /** Before a key inside the dialog: still the screen we expect, and no turn has started. */
  const guard = async (expect: (pane: string) => boolean, what: string): Promise<string> => {
    if (d.signal?.aborted) throw new Abort("stopped: the daemon is shutting down");
    const pane = await cap();
    if (looksActivelyBusy(pane) && !isMcpDialog(pane)) throw new Abort("a turn started");
    if (!expect(pane)) throw new Abort(`not on the ${what}`);
    return pane;
  };
  /** Move the cursor onto the line matching `target` inside the dialog, one key at a time, checking after each. The
   *  list may hold many servers in groups (headings the cursor skips) and scroll: move toward the target when it is
   *  on screen, else down; stop when the cursor no longer moves. */
  const moveTo = async (target: RegExp, expect: (pane: string) => boolean, what: string) => {
    let unmoved = 0;
    for (let i = 0; i < 80; i++) {
      const pane = await guard(expect, what);
      const m = menuCursor(pane, target);
      if (m.cursor < 0) throw new Abort(`no cursor on the ${what}`);
      if (m.cursor === m.target) return;
      await d.tmux.sendKeys(d.name, m.target >= 0 && m.target < m.cursor ? "Up" : "Down");
      // A freshly opened list may not take keys yet (Claude Code re-checks its servers): wait for the screen to
      // change; a key that changed nothing is sent again (positions are re-read first), a few times at most.
      const moved = await waitFor((p) => p !== pane, Math.max(delay, 1500));
      if (moved) { unmoved = 0; continue; }
      if (++unmoved >= 3) throw new Abort(`could not reach "${target.source}" on the ${what} (the cursor does not move)`);
    }
    throw new Abort(`could not reach "${target.source}" on the ${what}`);
  };
  /** Back to an empty prompt: Esc out of the /mcp dialog (only while it is on screen: an Esc anywhere else could
   *  dismiss a permission dialog or interrupt a turn), then clear a /mcp we typed. */
  const restore = async (): Promise<boolean> => {
    for (let i = 0; i < 4; i++) {
      const pane = await cap().catch(() => undefined);
      if (pane === undefined || !isMcpDialog(pane)) break;
      await d.tmux.sendKeys(d.name, "Escape").catch(() => {});
      await sleep(300);
    }
    const ansi = await capAnsi().catch(() => "");
    const text = inputBoxText(ansi);
    if (text === "/mcp" || (text !== undefined && "/mcp".startsWith(text) && text.startsWith("/"))) {
      for (let i = 0; i < text.length; i++) await d.tmux.sendKeys(d.name, "BSpace").catch(() => {});
      await sleep(200);
    }
    const pane = await cap().catch(() => "");
    return !isMcpDialog(pane) && isReady(pane) && inputBoxText(await capAnsi().catch(() => "")) === "";
  };

  const pre = await idleEmpty().catch((e) => `capture failed: ${String(e)}`);
  if (pre) return { ok: false, outcome: "skipped", detail: pre };
  const before = mcpResultCounts(await cap(), d.server);
  const t0 = Date.now();
  const serverLine = new RegExp(`^\\s*(❯\\s*)?[✔✘△◯○●◐⚠✗✓·*]?\\s*${escRe(d.server)}\\b`);
  try {
    // 1. /mcp + Enter (Enter accepts the /mcp completion).
    if (d.signal?.aborted) return { ok: false, outcome: "skipped", detail: "the daemon is shutting down" };
    await d.tmux.typeLiteral(d.name, "/mcp");
    await sleep(delay * 2);
    const typed = inputBoxText(await capAnsi());
    if (typed !== "/mcp") throw new Abort(`input box shows "${typed ?? "?"}" after typing /mcp`);
    await guard(() => true, "prompt");
    await d.tmux.sendKeys(d.name, "Enter");
    if (!(await waitFor((p) => isMcpList(p) || isMcpDetail(p, d.server), stepTimeout))) throw new Abort("the /mcp dialog did not open");
    // 2. The server list → our server (some versions open the detail directly when there is one server).
    if (!isMcpDetail(await cap(), d.server)) {
      await moveTo(serverLine, isMcpList, "MCP server list");
      await guard(isMcpList, "MCP server list");
      await d.tmux.sendKeys(d.name, "Enter");
      if (!(await waitFor((p) => isMcpDetail(p, d.server), stepTimeout))) throw new Abort(`the ${d.server} detail menu did not open`);
    }
    // 3. Reconnect.
    const onDetail = (p: string) => isMcpDetail(p, d.server);
    await moveTo(/^\s*(❯\s*)?(\d+\.\s*)?Reconnect\s*$/, onDetail, `${d.server} detail menu`);
    await guard(onDetail, `${d.server} detail menu`);
    await d.tmux.sendKeys(d.name, "Enter");
    // 4. The result line, the dialog closed.
    const done = await waitFor((p) => {
      const c = mcpResultCounts(p, d.server);
      return (c.ok > before.ok || c.failed > before.failed) && !isMcpDialog(p);
    }, resultTimeout);
    if (!done) throw new Abort("no reconnect result");
    const c = mcpResultCounts(done, d.server);
    if (c.failed > before.failed && c.ok <= before.ok) throw new Abort("Claude Code reports: failed to reconnect");
    // 5. The gateway saw it.
    const until = Date.now() + stepTimeout;
    while (!d.verify(t0) && Date.now() < until) await sleep(150);
    if (!d.verify(t0)) throw new Abort("the gateway saw no initialize");
    if (!(await restore())) return { ok: false, outcome: "failed", detail: "reconnected, but the pane is not back at an empty prompt" };
    return { ok: true, outcome: "reconnected", detail: `Reconnected to ${d.server}` };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const seen = await cap().catch(() => "");
    const clean = await restore();
    d.log?.("mcp reconnect stopped", { why, paneRestored: clean, pane: seen.split("\n").filter((l) => l.trim()).slice(-60).join("\n") });
    return { ok: false, outcome: e instanceof Abort && /turn started|stopped:/.test(why) ? "aborted" : "failed",
      detail: clean ? why : `${why}; the pane is not back at an empty prompt` };
  }
}

/** Answer the startup prompt on screen (STARTUP_PROMPTS: folder trust, bypass-permissions warning…). Returns its
 *  label when keys were sent. The caller decides whether this prompt may be answered at all. */
export async function answerStartupPrompt(tmux: Tmux, name: string, o: { keyDelayMs?: number } = {}): Promise<string | undefined> {
  const pane = await tmux.capture(name);
  const p = STARTUP_PROMPTS.find((x) => x.match(pane));
  if (!p) return undefined;
  return (await p.respond(tmux, name, pane, o)) ? p.label : undefined;
}

/** Esc out of a leftover `/mcp` dialog (a settings viewer: closing it changes nothing). */
export async function closeMcpDialog(tmux: Tmux, name: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const pane = await tmux.capture(name);
    if (!isMcpDialog(pane)) return isReady(pane);
    await tmux.sendKeys(name, "Escape");
    await sleep(300);
  }
  const pane = await tmux.capture(name);
  return !isMcpDialog(pane) && isReady(pane);
}
