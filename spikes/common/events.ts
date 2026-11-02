// Draft of the normalized provider event model (docs/architecture.md §5).
// Spikes map provider-native output onto this to prove the interface fits.
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export type AgentEvent =
  | { type: "session"; providerSessionId: string }
  | { type: "turn_start"; turnId: string }
  | { type: "text"; delta?: string; final?: string; segmentId: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary?: string }
  | { type: "permission_request"; id: string; tool: string; input: unknown; title: string }
  | { type: "turn_end"; turnId: string; reason: "done" | "interrupted" | "error"; usage?: unknown }
  | { type: "unsolicited_turn" }
  | { type: "error"; error: string; fatal: boolean };

/** Writes normalized events (and optionally raw provider frames) to out/*.jsonl. */
export class Recorder {
  readonly events: AgentEvent[] = [];
  constructor(private outDir: string, private quiet = false) {
    mkdirSync(outDir, { recursive: true });
  }
  emit(ev: AgentEvent) {
    this.events.push(ev);
    this.write("events.jsonl", { t: Date.now(), ...ev });
    if (!this.quiet) {
      const s = JSON.stringify(ev);
      console.log("  ev", s.length > 200 ? s.slice(0, 200) + "…" : s);
    }
  }
  raw(frame: unknown) { this.write("raw.jsonl", { t: Date.now(), frame }); }
  write(file: string, obj: unknown) {
    const p = `${this.outDir}/${file}`;
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(obj) + "\n");
  }
  has(type: AgentEvent["type"]) { return this.events.some((e) => e.type === type); }
}

export type ScenarioResult = { scenario: string; ok: boolean | "n/a"; notes: string };
export function report(outDir: string, adapter: string, results: ScenarioResult[]) {
  const lines = [`# ${adapter}`, "", "| scenario | ok | notes |", "|---|---|---|",
    ...results.map((r) => `| ${r.scenario} | ${r.ok === true ? "✅" : r.ok === false ? "❌" : "n/a"} | ${r.notes.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`)];
  Bun.write(`${outDir}/result.md`, lines.join("\n") + "\n");
  console.log("\n" + lines.join("\n"));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
