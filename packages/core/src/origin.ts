// Every input to a session carries an Origin. Output routing is decided from the
// origins of the turn — never by sniffing provider text (docs §4, §8.4).
import type { Sender, Target, MsgRef } from "./platform.ts";

export type Origin =
  | { kind: "human"; platform: string; channelKey: string; sender: Sender; replyTarget: Target; ref: MsgRef; trusted: boolean }
  | { kind: "peer"; fromSession: string; hop: number;
      /** ask: answer goes back to fromSession as a task result (no platform output).
       *  trigger: answer goes to this session's own human (deliverTo).
       *  result: an async ask result arriving back at the asker (routed like background output). */
      mode: "ask" | "trigger" | "result"; taskId: string;
      deliverTo?: Target;
      /** result: how many async results in a row have driven this session without a human message
       *  (bounds ask → result → ask rounds, which don't deepen the hop). */
      rounds?: number;
      /** Delegation chain this input belongs to (budget key, see bus.maxChainTasks): started by a human message,
       *  else by the turn that first asked. */
      chain?: string;
      /** Human target at the root of the delegation chain (for permission prompts). */
      rootTarget?: Target }
  | { kind: "scheduler"; job: string; deliverTo?: Target;
      /** replyTo "none": the final reply is not posted anywhere (the agent uses notify/agent_trigger itself). */
      silent?: boolean;
      /** Run this turn on this model (live model switch), then switch back. */
      model?: string;
      /** The final reply resolves this task (ChannelManager.complete): a plugin waits for the answer. */
      taskId?: string }
  | { kind: "a2a"; remote: string; taskId: string; hop: number }
  | { kind: "system"; reason: "resume" | "background" | "deny-recovery" | "notify-echo" | "external" | "retry" };

export function originLabel(o: Origin): string {
  switch (o.kind) {
    case "human": return `${o.platform}:${o.sender.username ?? o.sender.name}`;
    case "peer": return `peer:${o.fromSession}`;
    case "scheduler": return `job:${o.job}`;
    case "a2a": return `a2a:${o.remote}`;
    case "system": return `system:${o.reason}`;
  }
}
