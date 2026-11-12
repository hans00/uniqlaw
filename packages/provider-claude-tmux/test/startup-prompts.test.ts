// Startup prompts in waitForReady: the folder-trust dialog (numbered and unnumbered layouts) must be answered "Yes"
// by cursor position, exactly once per screen, so a dialog that lingers after Enter is not answered again with a
// blind Down that wraps onto "No, exit".
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMenu, waitForReady } from "../src/pane.ts";
import type { Tmux } from "../src/tmux.ts";

const fixture = (f: string) => readFileSync(join(import.meta.dir, "fixtures", f), "utf8");
const READY = ["", "─".repeat(60), "❯ ", "─".repeat(60), "  ? for shortcuts", ""].join("\n");
const YES = /Yes, I trust this folder/;

/** A fake pane that renders a menu dialog from a fixture and moves its `❯` like the TUI (Up/Down wrap around).
 *  Enter on "No, exit" kills claude; Enter on "Yes" reaches the prompt after `closeLagMs` (the dialog stays drawn
 *  until then, which is when a re-fire would hit it). The first `dropEnters` Enters are swallowed, as when the
 *  menu is not taking input yet. */
class MenuTmux {
  keys: string[] = [];
  dead = false;
  private lines: string[];
  private optRows: number[];
  private cursor: number;
  private chosenAt = 0;
  private chosen = "";
  constructor(screen: string, private closeLagMs: number, private dropEnters = 0) {
    this.lines = screen.split("\n");
    this.optRows = this.lines.map((l, i) => (/(Yes, I trust this folder|No, exit)/.test(l) && !/Enter to confirm/.test(l) ? i : -1)).filter((i) => i >= 0);
    this.cursor = this.optRows.findIndex((r) => this.lines[r]!.includes("❯"));
  }
  private optText(i: number) { return /Yes, I trust/.test(this.lines[this.optRows[i]!]!) ? "yes" : "no"; }
  private render() {
    return this.lines.map((l, i) => {
      const k = this.optRows.indexOf(i);
      if (k < 0) return l;
      const bare = l.replace("❯", " ");
      return k === this.cursor ? bare.replace(/^(\W*?)\s(\s*)(\d\.|Yes|No)/, "$1❯$2$3") : bare;
    }).join("\n");
  }
  async capture() {
    if (this.dead) throw new Error("no session");
    if (this.chosen === "yes" && Date.now() - this.chosenAt >= this.closeLagMs) return READY;
    return this.render();
  }
  async paneDead() { return this.dead; }
  async hasSession() { return !this.dead; }
  async sendKeys(_n: string, ...k: string[]) {
    for (const key of k) {
      this.keys.push(key);
      const n = this.optRows.length;
      if (key === "Down") this.cursor = (this.cursor + 1) % n;
      else if (key === "Up") this.cursor = (this.cursor - 1 + n) % n;
      else if (key === "Enter" && this.dropEnters > 0) this.dropEnters--; // swallowed (menu not taking input yet)
      else if (key === "Enter" && !this.chosen) {
        this.chosen = this.optText(this.cursor);
        this.chosenAt = Date.now();
        if (this.chosen === "no") this.dead = true;
      }
    }
  }
  async typeLiteral() {}
  async paste() {}
  async killSession() {}
}

const fast = { timeoutMs: 3000, pollMs: 10, afterPromptMs: 50, keyDelayMs: 1 };

test("parseMenu reads both layouts: cursor and target option", () => {
  const u = parseMenu(fixture("folder-trust-unnumbered.txt"), YES)!;
  expect(u.options.map((o) => o.text)).toEqual(["No, exit", "Yes, I trust this folder"]);
  expect([u.cursor, u.target]).toEqual([0, 1]);
  const n = parseMenu(fixture("folder-trust-numbered.txt"), YES)!;
  expect(n.options.map((o) => o.text)).toEqual(["Yes, I trust this folder", "No, exit"]);
  expect([n.cursor, n.target]).toEqual([0, 0]);
});

test("unnumbered trust dialog (cursor on \"No, exit\"): moves to Yes, checks the cursor, Enter → ready", async () => {
  const tmux = new MenuTmux(fixture("folder-trust-unnumbered.txt"), 0);
  const labels: string[] = [];
  const r = await waitForReady(tmux as unknown as Tmux, "t", { ...fast, onPrompt: (l) => labels.push(l) });
  expect(r.status).toBe("ready");
  expect(tmux.keys).toEqual(["Down", "Enter"]);
  expect(labels).toEqual(["folder-trust"]);
});

test("numbered trust dialog (cursor already on \"1. Yes\"): just Enter → ready", async () => {
  const tmux = new MenuTmux(fixture("folder-trust-numbered.txt"), 0);
  const r = await waitForReady(tmux as unknown as Tmux, "t", fast);
  expect(r.status).toBe("ready");
  expect(tmux.keys).toEqual(["Enter"]);
});

for (const f of ["folder-trust-unnumbered.txt", "folder-trust-numbered.txt"]) {
  test(`dialog stays drawn after Enter for many polls (${f}) → answered once, claude not exited`, async () => {
    const tmux = new MenuTmux(fixture(f), 600); // ≫ afterPromptMs and pollMs
    const r = await waitForReady(tmux as unknown as Tmux, "t", fast);
    expect(r.status).toBe("ready");
    expect(tmux.dead).toBe(false);
    expect(tmux.keys.filter((k) => k === "Enter")).toHaveLength(1);
  });

  test(`double fire: first Enter swallowed, dialog still up (${f}) → answered again by cursor, never "No, exit"`, async () => {
    // The old loop sent Down+Enter again here: the second Down wrapped back onto "No, exit" and claude exited.
    const tmux = new MenuTmux(fixture(f), 0, 1);
    const r = await waitForReady(tmux as unknown as Tmux, "t", { ...fast, reanswerMs: 100 });
    expect(r.status).toBe("ready");
    expect(tmux.dead).toBe(false);
    expect(tmux.keys.filter((k) => k === "Enter")).toHaveLength(2);
    expect(tmux.keys.filter((k) => k === "Down").length).toBeLessThanOrEqual(1);
  });
}

test("a lingering dialog answered again after reanswerMs is still answered by cursor (no wrap onto \"No, exit\")", async () => {
  const tmux = new MenuTmux(fixture("folder-trust-unnumbered.txt"), 400);
  const r = await waitForReady(tmux as unknown as Tmux, "t", { ...fast, reanswerMs: 100 });
  expect(r.status).toBe("ready");
  expect(tmux.dead).toBe(false);
  expect(tmux.keys.filter((k) => k === "Down")).toHaveLength(1); // later answers find the cursor on Yes: Enter only
});
