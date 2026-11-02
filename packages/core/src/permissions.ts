// Unified permission model (docs §10). Adapters translate it to provider flags.
export type SecurityLevel = "locked" | "strict" | "moderate" | "unrestricted";

export interface PermissionPolicy {
  level: SecurityLevel;
  allowTools: string[];
  denyTools: string[];
  approval: {
    mode: "ask-operator" | "auto-deny" | "auto-allow";
    timeoutSec: number;
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
