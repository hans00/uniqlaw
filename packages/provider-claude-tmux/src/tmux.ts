// tmux CLI wrapper bound to a per-instance socket (`tmux -L uniqlaw-<instanceId>`),
// so UniQlaw never touches the user's tmux server or another instance's.
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

interface RunResult { stdout: string; stderr: string; exitCode: number }

/** Exact session match for session-level commands. */
const S = (name: string) => "=" + name;
/** Exact session match for window/pane-level commands (`=name` alone resolves as a window). */
const P = (name: string) => `=${name}:`;

export class Tmux {
  constructor(readonly socket: string, private clientEnv: Record<string, string>) {}

  private async run(args: string[]): Promise<RunResult> {
    const proc = Bun.spawn(["tmux", "-L", this.socket, ...args], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", env: this.clientEnv,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { stdout, stderr, exitCode: proc.exitCode ?? -1 };
  }

  private async must(args: string[]): Promise<string> {
    const r = await this.run(args);
    if (r.exitCode !== 0) throw new Error(`tmux ${args[0]} failed (${r.exitCode}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.run(["has-session", "-t", S(name)])).exitCode === 0;
  }

  async listSessions(): Promise<string[]> {
    const r = await this.run(["list-sessions", "-F", "#{session_name}"]);
    return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }

  /** Start a detached session running `argv` directly (no shell → no rc files, no history). */
  async newSession(name: string, o: { cwd: string; env: Record<string, string>; argv: string[]; width?: number; height?: number }) {
    const args = ["new-session", "-d", "-s", name, "-x", String(o.width ?? 200), "-y", String(o.height ?? 50), "-c", o.cwd];
    for (const [k, v] of Object.entries(o.env)) args.push("-e", `${k}=${v}`);
    args.push("--", ...o.argv);
    await this.must(args);
    // Keep the pane after the process exits so a crash can be diagnosed (alive() checks pane_dead).
    await this.run(["set-option", "-t", P(name), "remain-on-exit", "on"]);
    await this.run(["set-option", "-t", P(name), "history-limit", "5000"]);
  }

  async killSession(name: string) {
    await this.run(["kill-session", "-t", S(name)]);
  }

  /** The pid of the pane's process (claude), or undefined. */
  async panePid(name: string): Promise<number | undefined> {
    const r = await this.run(["display-message", "-p", "-t", P(name), "#{pane_pid}"]);
    const n = Number(r.stdout.trim());
    return r.exitCode === 0 && n > 0 ? n : undefined;
  }

  async paneDead(name: string): Promise<boolean> {
    const r = await this.run(["display-message", "-p", "-t", P(name), "#{pane_dead}"]);
    return r.exitCode !== 0 || r.stdout.trim() === "1";
  }

  async sendKeys(name: string, ...keys: string[]) {
    if (keys.length) await this.must(["send-keys", "-t", P(name), ...keys]);
  }

  /** Literal text via send-keys -l (no key-name interpretation). Single-line only. */
  async typeLiteral(name: string, text: string) {
    await this.must(["send-keys", "-t", P(name), "-l", text]);
  }

  /** Multi-line safe: load-buffer + bracketed paste. */
  async paste(name: string, text: string) {
    const buf = `uq-${randomBytes(4).toString("hex")}`;
    const file = join(tmpdir(), `uniqlaw-paste-${Date.now()}-${buf}`);
    writeFileSync(file, text, { mode: 0o600 });
    try {
      await this.must(["load-buffer", "-b", buf, file]);
      await this.must(["paste-buffer", "-b", buf, "-d", "-p", "-t", P(name)]);
    } finally {
      try { unlinkSync(file); } catch {}
    }
  }

  async capture(name: string, startLine?: number): Promise<string> {
    const args = ["capture-pane", "-p", "-t", P(name)];
    if (startLine !== undefined) args.push("-S", String(startLine));
    return this.must(args);
  }
}
