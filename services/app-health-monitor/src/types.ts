// Shared result shapes for one poll cycle.
import type { Health } from "./checks";

export type { Health };
export type TargetKind = "frontend" | "service";

/** The health of a single monitored target after one probe. */
export interface TargetResult {
  id: string; // stable id, e.g. "fe:mail" | "svc:notification" | "svc:api-gateway"
  kind: TargetKind;
  label: string;
  status: Health;
  detail: string; // human description of the probe outcome (status code / error / marker)
}

/** Prior persisted state for a target (from D1). Absent => first-ever sighting. */
export interface TargetState {
  targetId: string;
  status: Health;
  consecutiveFails: number;
  downSince: string | null; // ISO of the first fail in the current down streak
  notified: boolean; // have we already alerted admins for the current down streak?
  lastError: string | null;
  lastCheckedAt: string;
}

/** What a cycle decided for one target (drives notify + persistence). */
export interface TargetTransition {
  result: TargetResult;
  prev: TargetState | null;
  next: TargetState;
  fire: "down" | "recovery" | null; // an admin notification to send, if any
}

export interface CycleSummary {
  checked: number;
  down: number;
  firedDown: number;
  firedRecovery: number;
  results: TargetResult[];
}
