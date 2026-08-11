// Percentage math + status/threshold logic. Pure and side-effect free (unit-tested).
import type { UsageStatus } from "./types";

/** warn at 70%, critical at 90% of the free-tier ceiling. */
export const WARN_PCT = 70;
export const CRITICAL_PCT = 90;

/** used/limit as a 1-decimal percentage. null when usage is unknown or the limit is
 *  non-positive (guards divide-by-zero). */
export function computePct(used: number | null, limit: number): number | null {
  if (used === null || !Number.isFinite(used)) return null;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

/** Map a pct to a status. A null pct (unmeasured) is "unknown". */
export function statusForPct(pct: number | null): UsageStatus {
  if (pct === null) return "unknown";
  if (pct >= CRITICAL_PCT) return "critical";
  if (pct >= WARN_PCT) return "warn";
  return "ok";
}

// Severity ordering for the roll-up: a known critical/warn outranks an unmeasured metric,
// which in turn outranks all-ok (an unknown is worse than ok because it hides risk).
const SEVERITY: Record<UsageStatus, number> = { ok: 0, unknown: 1, warn: 2, critical: 3 };

/** The worst (highest-severity) status across a set. Empty set -> "ok". */
export function worstStatus(statuses: readonly UsageStatus[]): UsageStatus {
  let worst: UsageStatus = "ok";
  for (const s of statuses) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}
