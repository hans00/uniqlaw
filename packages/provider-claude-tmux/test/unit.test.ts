import { describe, expect, test } from "bun:test";
import { findLegacySessions, killLegacySessions, looksActivelyBusy, isReady, parsePermissionDialog, slug } from "../src/index.ts";

describe("legacy takeover", () => {
  const sid = "07a068a8-a5bc-4322-8394-9c2501c44763";
  const panes = [{ session: "claudeclaw-ab12-telegram-1", pid: 100 }, { session: "my-own", pid: 200 }, { session: "claudeclaw-ab12-global", pid: 300 }];
  const procs = [
    { pid: 100, ppid: 1, args: "-zsh" },
    { pid: 101, ppid: 100, args: `claude --resume ${sid} --append-system-prompt x` },
    { pid: 200, ppid: 1, args: "-zsh" },
    { pid: 201, ppid: 200, args: `vim notes-${sid}.md` },
    { pid: 300, ppid: 1, args: "-zsh" },
    { pid: 301, ppid: 300, args: "claude --resume 11111111-2222-3333-4444-555555555555" },
  ];
  test("finds only the pane running claude with that session id", () => {
    expect(findLegacySessions(sid, panes, procs)).toEqual(["claudeclaw-ab12-telegram-1"]);
  });
  test("kills via deps", async () => {
    const killed: string[] = [];
    const r = await killLegacySessions(sid, { listDefaultPanes: async () => panes, listProcs: async () => procs, killDefaultSession: async (n) => { killed.push(n); } });
    expect(r).toEqual(killed);
    expect(killed).toEqual(["claudeclaw-ab12-telegram-1"]);
  });
});

describe("pane heuristics", () => {
  const box = "────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts";
  test("ready box", () => expect(isReady(box)).toBe(true));
  test("ready box with a session name on the top border", () => {
    const named = "──────────────────────────────────────── claudeclaw-global ─\n❯ \n────────────────────────────────────────\n  ⏸ manual mode on · ← 1 agent";
    expect(isReady(named)).toBe(true);
  });
  test("plain separator lines are not a ready box", () => {
    expect(isReady("──────────────────────────────────────── some text\nreply line\n────────────────────────────────────────")).toBe(false);
  });
  test("new spinner shape counts as busy", () => {
    expect(looksActivelyBusy("✻ Warping… (2s · ↓ 75 tokens)\n" + box)).toBe(true);
    expect(looksActivelyBusy("✶ Pondering… (12s)\n" + box)).toBe(true);
    expect(looksActivelyBusy("some reply text.\n" + box)).toBe(false);
  });
  test("permission dialog with wrapped option", () => {
    const pane = [
      "  Bash command",
      "    touch /tmp/x",
      "  Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and always allow access to /home/user/projects/very/long/path",
      "     from this project",
      "  3. No, and tell Claude what to do differently (esc)",
      "",
    ].join("\n");
    const d = parsePermissionDialog(pane)!;
    expect(d.kind).toBe("permission");
    expect(d.options.length).toBe(3);
    expect(d.options[1]).toContain("from this project");
  });
  test("slug", () => {
    expect(slug("telegram:-1001234")).toBe("telegram-1001234");
    expect(slug("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });
});
