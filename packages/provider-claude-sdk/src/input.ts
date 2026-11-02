// Async-iterable input queue for the SDK's streaming-input mode.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type Priority = "now" | "next" | "later";

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private q: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(text: string, priority?: Priority) {
    if (this.closed) throw new Error("input closed");
    this.q.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    } as SDKUserMessage);
    this.wake?.();
  }

  close() { this.closed = true; this.wake?.(); }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.q.length) yield this.q.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}
