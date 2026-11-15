// MCP auto-recovery (docs §11.4): the /mcp pane parsers against real captures (Claude Code 2.1.325, fixtures/mcp),
// and the reconnect driver against a fake TUI that behaves like the captured one.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePermissionDialog } from "../src/dialogs.ts";
import { classifyBlocker, closeMcpDialog, inputBoxText, isMcpDetail, isMcpDialog, isMcpList, mcpResultCounts, reconnectMcp } from "../src/mcp.ts";
import { isReady } from "../src/pane.ts";
import type { Tmux } from "../src/tmux.ts";

const fx = (f: string) => readFileSync(join(import.meta.dir, "fixtures", "mcp", f), "utf8");

test("fixtures: list / detail / result screens are told apart; the detail menu is not a permission dialog", () => {
  expect(isMcpList(fx("mcp-list-ok.txt"))).toBe(true);
  expect(isMcpList(fx("mcp-list-failed.txt"))).toBe(true);
  expect(isMcpDetail(fx("mcp-detail-ok.txt"), "uniqlaw")).toBe(true);
  expect(isMcpDetail(fx("mcp-detail-failed.txt"), "uniqlaw")).toBe(true);
  expect(isMcpDetail(fx("mcp-detail-failed.txt"), "other")).toBe(false);
  // Same numbered-block shape as a permission prompt, but must never be forwarded as one.
  expect(parsePermissionDialog(fx("mcp-detail-ok.txt"))).toBeNull();
  expect(parsePermissionDialog(fx("mcp-detail-failed.txt"))).toBeNull();
  expect(classifyBlocker(fx("mcp-detail-failed.txt"))).toEqual({ kind: "mcp-dialog" });
  expect(classifyBlocker(fx("mcp-list-ok.txt"))).toEqual({ kind: "mcp-dialog" });
  for (const f of ["mcp-reconnected.txt", "mcp-reconnect-failed.txt"]) {
    expect(isMcpDialog(fx(f))).toBe(false);
    expect(isReady(fx(f))).toBe(true);
    expect(classifyBlocker(fx(f))).toBeUndefined();
  }
  // The probe reconnected twice in that pane: both result lines count.
  expect(mcpResultCounts(fx("mcp-reconnected.txt"), "uniqlaw")).toEqual({ ok: 2, failed: 0 });
  expect(mcpResultCounts(fx("mcp-reconnect-failed.txt"), "uniqlaw").failed).toBe(1);
});

test("fixtures: a dim suggestion in the input box counts as empty, typed text does not", () => {
  expect(inputBoxText(fx("idle-empty.ansi"))).toBe("");
  // `❯\u00a0` + SGR 2 (dim) "call it again": the suggestion Claude Code shows after a turn (captured bytes).
  expect(inputBoxText(fx("idle-suggestion.ansi"))).toBe("");
  expect(inputBoxText(fx("mcp-reconnected.ansi"))).toBe("");
  const typed = fx("idle-suggestion.ansi").replace(/❯ ?\s*\x1b\[2m[^\x1b]*\x1b\[0m/, "❯ \x1b[38;5;231mhello there\x1b[39m");
  expect(inputBoxText(typed)).toBe("hello there");
  expect(inputBoxText("no box here")).toBeUndefined();
});

// ── fake TUI ────────────────────────────────────────────────────────────────

const RULE = "─".repeat(80);
type Screen = "prompt" | "list" | "detail";

class FakeTui {
  keys: string[] = [];
  screen: Screen = "prompt";
  input = "";
  history: string[] = ["▐▛███▛█   Claude Code v2.1.325", ""];
  listCursor = 0; // index into listItems
  /** Servers before uniqlaw, each optionally under a group heading (like a real setup with many MCP servers). */
  extra: { heading?: string; name: string }[] = [];
  get listItems() { return [{ heading: "Built-in MCPs (always available)", name: "✔ claude-in-chrome   20 tools" }, ...this.extra,
    { name: this.connected ? "✔ uniqlaw            1 tool" : "✘ uniqlaw" }]; }
  detailCursor = 0;
  busy = false;
  /** Called when Reconnect succeeds (the gateway would see an initialize). */
  onReconnect = () => {};
  constructor(public connected: boolean, public reconnectWorks = true, public hooks: { afterKey?: (t: FakeTui, key: string) => void } = {}) {}
  get options() { return this.connected ? ["View tools", "Authenticate", "Reconnect", "Disable"] : ["Authenticate", "Reconnect", "Disable"]; }
  render(ansi: boolean): string {
    const h = [...this.history];
    if (this.screen === "prompt") {
      if (this.busy) h.push("✻ Warping… (2s · ↓ 75 tokens)");
      const box = this.input ? (ansi ? `❯ \x1b[38;5;231m${this.input}\x1b[39m` : `❯ ${this.input}`)
        : (ansi ? "❯ \x1b[2mcall it again\x1b[0m" : "❯ call it again");
      return [...h, RULE, box, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    }
    if (this.screen === "list") {
      const rows = this.listItems.flatMap((it, i) => [...(it.heading ? ["", `     ${it.heading}`] : []), `   ${this.listCursor === i ? "❯" : " "} ${it.name}`]);
      return [...h, "▔".repeat(80), "   Manage MCP servers", `   ${this.listItems.length} servers`, ...rows, "",
        "   https://code.claude.com/docs/en/mcp for help", "", "   ↑/↓ to navigate · Enter to confirm · Esc to cancel"].join("\n");
    }
    return [...h, "▔".repeat(80), "   Uniqlaw MCP Server", "", `   Status:           ${this.connected ? "✔ connected" : "✘ failed"}`,
      "   URL:              http://127.0.0.1:34999", "",
      ...this.options.map((o, i) => `   ${this.detailCursor === i ? "❯" : " "} ${i + 1}. ${o}`), "",
      "   ↑/↓ to navigate · Enter to select · Esc to back"].join("\n");
  }
  private key(k: string) {
    this.keys.push(k);
    if (this.screen === "prompt") {
      if (k === "Enter" && this.input === "/mcp") { this.history.push("❯ /mcp"); this.input = ""; this.screen = "list"; this.listCursor = 0; }
      else if (k === "BSpace") this.input = this.input.slice(0, -1);
    } else if (this.screen === "list") {
      if (k === "Down") this.listCursor = Math.min(this.listItems.length - 1, this.listCursor + 1);
      else if (k === "Up") this.listCursor = Math.max(0, this.listCursor - 1);
      else if (k === "Escape") { this.screen = "prompt"; this.history.push("  ⎿  MCP dialog dismissed"); }
      else if (k === "Enter" && this.listCursor === this.listItems.length - 1) { this.screen = "detail"; this.detailCursor = 0; }
    } else {
      if (k === "Down") this.detailCursor = Math.min(this.options.length - 1, this.detailCursor + 1);
      else if (k === "Up") this.detailCursor = Math.max(0, this.detailCursor - 1);
      else if (k === "Escape") this.screen = "list";
      else if (k === "Enter") {
        const o = this.options[this.detailCursor];
        if (o === "Reconnect") {
          this.screen = "prompt";
          if (this.reconnectWorks) { this.connected = true; this.history.push("  ⎿  Reconnected to uniqlaw."); this.onReconnect(); }
          else this.history.push("  ⎿  Failed to reconnect to uniqlaw: ECONNREFUSED at http://127.0.0.1:34999");
        } else if (o === "Disable") { this.screen = "prompt"; this.history.push("  ⎿  Disabled uniqlaw"); }
        // Authenticate / View tools: stays here (a wrong choice the driver must never make)
        else this.history.push("   SDK auth failed");
      }
    }
    this.hooks.afterKey?.(this, k);
  }
  tmux(): Tmux {
    return {
      capture: async () => this.render(false),
      captureAnsi: async () => this.render(true),
      sendKeys: async (_n: string, ...ks: string[]) => { for (const k of ks) this.key(k); },
      typeLiteral: async (_n: string, t: string) => { if (this.screen === "prompt") this.input += t; this.hooks.afterKey?.(this, `literal:${t}`); },
    } as unknown as Tmux;
  }
}

function deps(t: FakeTui, verifyOk = true) {
  let initAt = 0;
  t.onReconnect = () => { if (verifyOk) initAt = Date.now(); };
  return { tmux: t.tmux(), name: "p", server: "uniqlaw", verify: (since: number) => initAt >= since, keyDelayMs: 1, stepTimeoutMs: 300, resultTimeoutMs: 300 };
}
const atEmptyPrompt = (t: FakeTui) => t.screen === "prompt" && t.input === "";

test("failed server: /mcp → uniqlaw → Reconnect (by text: the cursor starts on Authenticate), verified by the gateway", async () => {
  const t = new FakeTui(false);
  const r = await reconnectMcp(deps(t));
  expect(r).toEqual({ ok: true, outcome: "reconnected", detail: "Reconnected to uniqlaw" });
  expect(t.keys).toEqual(["Enter", "Down", "Enter", "Down", "Enter"]);
  expect(t.history).not.toContain("   SDK auth failed");
  expect(atEmptyPrompt(t)).toBe(true);
});

test("many servers in groups (as on a real setup): walks the cursor down past headings to uniqlaw", async () => {
  const t = new FakeTui(false);
  t.extra = [{ heading: "claude.ai", name: "⚠ claude.ai Notion   needs authentication" }, { name: "⚠ claude.ai Taiwan   needs authentication" },
    { heading: "Plugins", name: "◯ plugin:engineering:gmail   not configured" }, { name: "⚠ plugin:vanta:vanta-us   needs authentication" }];
  const r = await reconnectMcp(deps(t));
  expect(r.ok).toBe(true);
  expect(t.keys.filter((k) => k === "Down").length).toBe(6); // chrome → 4 extra servers → uniqlaw, + 1 in the detail menu
  expect(t.history).not.toContain("   SDK auth failed");
  expect(atEmptyPrompt(t)).toBe(true);
});

test("connected server (View tools first): still lands on Reconnect", async () => {
  const t = new FakeTui(true);
  const r = await reconnectMcp(deps(t));
  expect(r.ok).toBe(true);
  expect(t.keys).toEqual(["Enter", "Down", "Enter", "Down", "Down", "Enter"]);
  expect(atEmptyPrompt(t)).toBe(true);
});

test("Claude Code reports a failed reconnect: failed, pane back at an empty prompt", async () => {
  const t = new FakeTui(false, false);
  const r = await reconnectMcp(deps(t));
  expect(r).toMatchObject({ ok: false, outcome: "failed" });
  expect(r.detail).toContain("failed to reconnect");
  expect(atEmptyPrompt(t)).toBe(true);
});

test("the gateway saw no initialize: failed (Claude Code's own message is not trusted alone)", async () => {
  const t = new FakeTui(false);
  const r = await reconnectMcp(deps(t, false));
  expect(r).toMatchObject({ ok: false, outcome: "failed", detail: "the gateway saw no initialize" });
  expect(atEmptyPrompt(t)).toBe(true);
});

test("a turn starting mid-sequence aborts: Esc out, typed /mcp cleared, nothing selected", async () => {
  const t = new FakeTui(false, true, { afterKey: (tui, k) => { if (k === "literal:/mcp") tui.busy = true; } });
  const r = await reconnectMcp(deps(t));
  expect(r).toMatchObject({ ok: false, outcome: "aborted" });
  expect(t.keys).not.toContain("Enter");
  expect(atEmptyPrompt(t)).toBe(true);
});

test("a step that doesn't verify (dialog closes under us) leaves the pane at an empty prompt, never in a menu", async () => {
  // Someone presses Esc right after the list opens.
  let once = false;
  const t = new FakeTui(false, true, { afterKey: (tui, k) => { if (k === "Enter" && tui.screen === "list" && !once) { once = true; tui.screen = "prompt"; } } });
  const r = await reconnectMcp(deps(t));
  expect(r.ok).toBe(false);
  expect(atEmptyPrompt(t)).toBe(true);
});

test("never starts unless idle at an empty prompt: typed text, a busy pane or an open dialog → skipped, no keys", async () => {
  const typed = new FakeTui(false); typed.input = "half a message";
  expect(await reconnectMcp(deps(typed))).toMatchObject({ outcome: "skipped", detail: "the input box is not empty" });
  expect(typed.keys).toEqual([]);
  const busy = new FakeTui(false); busy.busy = true;
  expect(await reconnectMcp(deps(busy))).toMatchObject({ outcome: "skipped", detail: "busy" });
  const dialog = new FakeTui(false); dialog.screen = "list";
  expect((await reconnectMcp(deps(dialog))).outcome).toBe("skipped");
  expect(dialog.keys).toEqual([]);
});

test("closeMcpDialog: Esc out of a leftover /mcp detail menu back to the prompt", async () => {
  const t = new FakeTui(true); t.screen = "detail";
  expect(await closeMcpDialog(t.tmux(), "p")).toBe(true);
  expect(t.keys).toEqual(["Escape", "Escape"]);
  expect(t.screen as Screen).toBe("prompt");
});
