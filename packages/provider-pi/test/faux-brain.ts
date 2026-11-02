// A deterministic stand-in LLM for pi-ai's faux provider: reads the transcript and
// plays the provider-contract scenarios the way a cooperative model would. Lets the
// full contract suite run through the real pi harness with no credentials.
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";

type Msg = { role: string; content?: unknown; toolName?: string; isError?: boolean; toolsAdded?: unknown; sections?: Record<string, string> };

const textOf = (m: Msg): string =>
  typeof m.content === "string" ? m.content
    : Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("") : "";

function toolNames(msgs: Msg[]): string[] {
  const names = new Set<string>();
  for (const m of msgs) {
    if (m.role !== "system") continue;
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.name === "string") names.add(o.name);
        Object.values(o).forEach(walk);
      }
    };
    walk(m.toolsAdded);
    for (const line of (m.sections?.tools ?? "").split("\n")) {
      const mm = line.match(/^- ([\w.-]+):/);
      if (mm) names.add(mm[1]!);
    }
  }
  return [...names];
}

const isSteer = (t: string) => /^Also:/i.test(t.trim());

export function createFauxBrain() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-a" }, { id: "faux-b" }], tokensPerSecond: 600 });

  const brain: FauxResponseFactory = (ctx) => {
    faux.appendResponses([brain]); // stay armed for the next LLM call
    const msgs = ctx.messages as unknown as Msg[];
    const users = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.role === "user");
    const task = [...users].reverse().find((x) => !isSteer(textOf(x.m)));
    if (!task) return fauxAssistantMessage("OK");
    const t = textOf(task.m);
    const after = msgs.slice(task.i + 1);
    const results = after.filter((m) => m.role === "toolResult");
    const steered = users.some((x) => x.i > task.i && isSteer(textOf(x.m)));
    const tools = toolNames(msgs);

    let m: RegExpMatchArray | null;
    if ((m = t.match(/Reply with exactly: (\S+)/))) return fauxAssistantMessage(m[1]!);
    if (/ListAgents or SendMessage/.test(t)) {
      const have = ["ListAgents", "SendMessage"].filter((n) => tools.includes(n));
      return fauxAssistantMessage(have.length ? have.join(", ") : "NONE");
    }
    if ((m = t.match(/run exactly: (.+)\n/))) {
      if (!results.length) return fauxAssistantMessage([fauxToolCall("bash", { command: m[1]!.trim() })], { stopReason: "toolUse" });
      return fauxAssistantMessage(results.at(-1)!.isError ? "BLOCKED" : "DONE");
    }
    if (/essay/i.test(t)) return fauxAssistantMessage(Array.from({ length: 4000 }, (_, i) => `tea${i % 10}`).join(" "));
    if (/three separate times/.test(t)) {
      const cmds = [...t.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
      if (results.length < cmds.length) return fauxAssistantMessage([fauxToolCall("bash", { command: cmds[results.length]! })], { stopReason: "toolUse" });
      const letters = results.map((r) => textOf(r).trim()).join(" ");
      return fauxAssistantMessage(`${letters}${steered ? " INJECTED" : ""}`);
    }
    if ((m = t.match(/Remember the codeword (\S+?)\./))) return fauxAssistantMessage("NOTED");
    if (/What codeword/.test(t)) {
      const earlier = users.map((x) => textOf(x.m).match(/Remember the codeword (\S+?)\./)?.[1]).find(Boolean);
      return fauxAssistantMessage(earlier ?? "UNKNOWN");
    }
    if ((m = t.match(/Call the (\w+) tool/))) {
      const name = tools.find((n) => n === m![1] || n.endsWith(`__${m![1]}`));
      if (!name) return fauxAssistantMessage(`NO_TOOL ${m[1]} among ${tools.join(",")}`);
      const note = t.match(/note '([^']+)'/)?.[1] ?? "";
      if (!results.length) return fauxAssistantMessage([fauxToolCall(name, { note })], { stopReason: "toolUse" });
      return fauxAssistantMessage(textOf(results.at(-1)!));
    }
    return fauxAssistantMessage("OK");
  };

  faux.setResponses([brain]);
  return faux;
}
