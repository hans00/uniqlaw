// SDKMessage → AgentEvent. Pure state machine (no I/O) so it can be unit-tested.
import type { AgentEvent, Usage, UsageLimit } from "@uniqlaw/core";
import { describeUsageLimit, formatResetTime, isCrossSessionMessage } from "@uniqlaw/claude-common";

/** Loose view of SDK messages: the union is huge and versioned; we read defensively. */
type Msg = { type: string; subtype?: string; [k: string]: any };

export function classifyError(text: string): string {
  const t = text.toLowerCase();
  if (/usage limit|limit reached|you[’']?ve (?:hit|reached) your\b[^\n]{0,40}?\blimit\b|out of (extra )?usage|quota|billing|credit balance/.test(t)) return "usage_limit";
  if (/rate.?limit|429|overloaded|529|too many requests/.test(t)) return "rate_limit";
  if (/auth|login|401|403|invalid api key|oauth|not logged in/.test(t)) return "auth";
  return text || "crash";
}

export class SdkMapper {
  inTurn = false;
  private turnN = 0;
  private turnId = "";
  private segN = 0;
  /** Text segments that received deltas but no final yet (FIFO). */
  private openSegs: string[] = [];
  private curDeltaSeg?: string;
  private lastErrorText = "";
  /** A rejected rate_limit_event of this turn: the subscription window and when it resets (epoch ms). */
  private rejected?: { type?: string; resetAt?: number };
  sessionId?: string;
  model?: string;

  /** What is known about a usage limit: the result text ("You've hit your 5-hour limit · resets 2:10am (…)") and/or
   *  the rejected rate_limit_event (window type, resetsAt). */
  private limitOf(text: string): UsageLimit | undefined {
    const d = describeUsageLimit(text);
    const r = this.rejected;
    const kind = d.kind !== "usage" ? d.kind : r?.type?.startsWith("five_hour") ? "5-hour" : r?.type?.startsWith("seven_day") ? "weekly" : "usage";
    const resetAt = d.resetAt ?? r?.resetAt;
    const resets = d.resets ?? (r?.resetAt !== undefined ? formatResetTime(r.resetAt) : undefined);
    return { kind, ...(resets ? { resets } : {}), ...(resetAt !== undefined ? { resetAt } : {}) };
  }

  /** Called when we send a prompt: a turn starts now. */
  beginTurn(): AgentEvent[] {
    if (this.inTurn) return [];
    this.inTurn = true;
    this.turnId = `t${++this.turnN}`;
    return [{ type: "turn_start", turnId: this.turnId }];
  }

  private ensureTurn(out: AgentEvent[], source: "background" | "external" = "background") {
    if (this.inTurn) return;
    // Output without a prompt from us: background task / wakeup / injected peer message.
    out.push({ type: "unsolicited_turn", source });
    out.push(...this.beginTurn());
  }

  map(m: Msg): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (m.type) {
      case "system": {
        if (m.subtype === "init") {
          if (m.session_id && m.session_id !== this.sessionId) {
            this.sessionId = m.session_id;
            out.push({ type: "session", providerSessionId: m.session_id });
          }
          if (m.model && m.model !== this.model) this.model = m.model;
        } else if (m.subtype === "api_retry") {
          this.lastErrorText = String(m.error ?? m.message ?? "");
        }
        break;
      }
      case "user": {
        if (m.isReplay) break;
        const content = m.message?.content;
        const texts: string[] = typeof content === "string" ? [content]
          : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text)) : [];
        if (texts.some(isCrossSessionMessage)) {
          if (!this.inTurn) this.ensureTurn(out, "external");
          else out.push({ type: "unsolicited_turn", source: "external" });
        }
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type !== "tool_result") continue;
            const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            out.push({ type: "tool_end", id: String(b.tool_use_id), ok: !b.is_error, summary: raw.slice(0, 300) });
          }
        }
        break;
      }
      case "stream_event": {
        const ev = m.event;
        if (!ev) break;
        if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
          this.ensureTurn(out);
          this.curDeltaSeg = `s${++this.segN}`;
          this.openSegs.push(this.curDeltaSeg);
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          this.ensureTurn(out);
          if (!this.curDeltaSeg) { this.curDeltaSeg = `s${++this.segN}`; this.openSegs.push(this.curDeltaSeg); }
          out.push({ type: "text", segmentId: this.curDeltaSeg, delta: String(ev.delta.text ?? "") });
        } else if (ev.type === "content_block_stop") {
          this.curDeltaSeg = undefined;
        }
        break;
      }
      case "assistant": {
        this.ensureTurn(out);
        if (m.message?.model && m.message.model !== this.model) this.model = m.message.model;
        for (const b of m.message?.content ?? []) {
          if (b.type === "text") {
            const seg = this.openSegs.shift() ?? `s${++this.segN}`;
            out.push({ type: "text", segmentId: seg, final: String(b.text ?? "") });
          } else if (b.type === "thinking") {
            if (b.thinking) out.push({ type: "thinking", segmentId: `th${++this.segN}`, text: String(b.thinking) });
          } else if (b.type === "tool_use") {
            out.push({ type: "tool_start", id: String(b.id), name: String(b.name), input: b.input });
          }
        }
        if (m.error) this.lastErrorText = String(m.error);
        break;
      }
      case "rate_limit_event": {
        const info = m.rate_limit_info ?? {};
        // A rejected subscription window (five_hour, seven_day…) is the usage limit, not a retryable rate limit.
        if (info.status === "rejected") {
          this.lastErrorText = `usage limit reached (${info.rateLimitType ?? "?"})`;
          const resetsAt = Number(info.resetsAt);
          this.rejected = { ...(info.rateLimitType ? { type: String(info.rateLimitType) } : {}), ...(resetsAt > 0 ? { resetAt: resetsAt * 1000 } : {}) };
        }
        break;
      }
      case "result": {
        if (!this.inTurn) out.push(...this.beginTurn());
        const usage: Usage = {
          inputTokens: m.usage?.input_tokens, outputTokens: m.usage?.output_tokens, costUsd: m.total_cost_usd,
        };
        const terminal = String(m.terminal_reason ?? "");
        const interrupted = /abort|interrupt/i.test(terminal);
        if (m.subtype === "success" && !m.is_error && !interrupted) {
          out.push({ type: "turn_end", turnId: this.turnId, reason: "done", usage });
        } else if (interrupted) {
          out.push({ type: "turn_end", turnId: this.turnId, reason: "interrupted", usage });
        } else {
          const errs = [...(Array.isArray(m.errors) ? m.errors : []), m.result, this.lastErrorText].filter(Boolean).map(String).join("; ");
          const error = classifyError(errs || String(m.subtype ?? ""));
          const limit = error === "usage_limit" ? this.limitOf(errs) : undefined;
          out.push({ type: "turn_end", turnId: this.turnId, reason: "error", usage, error, ...(limit ? { limit } : {}) });
        }
        this.inTurn = false;
        this.openSegs = [];
        this.curDeltaSeg = undefined;
        this.lastErrorText = "";
        this.rejected = undefined;
        break;
      }
      default:
        break;
    }
    return out;
  }
}
