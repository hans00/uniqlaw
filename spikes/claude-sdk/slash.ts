import { query } from "@anthropic-ai/claude-agent-sdk";
for (const p of ["/claudeclaw2:help", "/context"]) {
  const q = query({ prompt: p, options: { cwd: `${import.meta.dir}/work`, model: "haiku", settingSources: ["user","project","local"], disallowedTools: ["ListAgents","SendMessage"], maxTurns: 2 } as any });
  const out: string[] = [];
  for await (const m of q as any) {
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") out.push("ASST:" + b.text.slice(0, 160).replace(/\n/g, " "));
    if (m.type === "user" && typeof m.message?.content === "string") out.push("USER:" + m.message.content.slice(0, 160).replace(/\n/g, " "));
    if (m.type === "result") out.push(`RESULT:${m.subtype} ${String(m.result ?? "").slice(0, 160).replace(/\n/g, " ")}`);
  }
  console.log(`== ${p}\n` + out.join("\n"));
}
