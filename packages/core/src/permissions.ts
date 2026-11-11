// Unified permission model (docs §10). Adapters translate it to provider flags.
export type SecurityLevel = "locked" | "strict" | "moderate" | "unrestricted";

import type { SecretRef } from "./credentials.ts";

/** permissions.approval.judge (docs §10.4): a decision model scores requests before the operator is asked. */
export interface ApprovalJudgeConfig {
  /** Judge provider ("typesafe-jev"; tests register their own). */
  provider: string;
  /** off: no judge (behaviour as without this block). shadow: score and log, always ask the operator. enforce:
   *  auto-allow (once) at or above the threshold. */
  mode: "off" | "shadow" | "enforce";
  /** Backend settings (baseUrl, model, credential, authHeader, headers, …), validated by the backend. */
  options?: Record<string, unknown>;
  /** Shorthand for options.credential. */
  credential?: SecretRef;
  /** Shorthand for options.model. */
  model?: string;
  /** Floor for every session kind's threshold. */
  allowAbove: number;
  /** P(safe) needed to auto-allow, per session kind; "off" = never. a2a is never auto-allowed, whatever it says. */
  byKind: { chat: number | "off"; worker: number | "off"; cron: number | "off"; peer: number | "off"; a2a?: number | "off" };
  /** Judge budget; on expiry the request goes to the operator. */
  timeoutMs: number;
  /** Write `<stateDir>/approvals/YYYY-MM.jsonl`. */
  audit: boolean;
}

export interface PermissionPolicy {
  level: SecurityLevel;
  allowTools: string[];
  denyTools: string[];
  approval: {
    mode: "ask-operator" | "auto-deny" | "auto-allow";
    /** How long to wait for the operator before denying; 0 = wait indefinitely. */
    timeoutSec: number;
    judge?: ApprovalJudgeConfig;
  };
  /** Restrict file access to these dirs (enforced by prompt + provider flags where possible). */
  dirScope?: string[];
}

export const DEFAULT_PERMISSIONS: PermissionPolicy = {
  level: "moderate",
  allowTools: [],
  denyTools: [],
  approval: { mode: "ask-operator", timeoutSec: 300 },
};
