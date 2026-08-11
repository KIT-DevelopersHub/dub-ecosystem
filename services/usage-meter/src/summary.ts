// Build the frozen GET /usage/summary contract from snapshot rows. Iterates the MASTER so
// the metric set + display order are stable and always complete: a metric with no snapshot
// row (never collected) renders as status="unknown" with null used/pct. resetsAt is computed
// at read time from the metric's reset cadence relative to `now`.
import { MASTER, MASTER_BY_KEY, resetAt } from "./limits";
import { worstStatus } from "./thresholds";
import type { SnapshotRow, UsageServiceSummary, UsageStatus, UsageSummary } from "./types";

export function buildSummary(rows: readonly SnapshotRow[], now: Date): UsageSummary {
  const byKey = new Map(rows.map((r) => [r.metric_key, r]));

  const services: UsageServiceSummary[] = MASTER.map((def) => {
    const row = byKey.get(def.metricKey);
    const status: UsageStatus = row ? row.status : "unknown";
    return {
      provider: def.provider,
      metricKey: def.metricKey,
      label: def.label,
      used: row ? row.used : null,
      limit: def.limit,
      pct: row ? row.pct : null,
      unit: def.unit,
      resetsAt: resetAt(def.reset, now),
      overflowBehavior: def.overflowBehavior,
      status,
    };
  });

  return {
    generatedAt: now.toISOString(),
    worstStatus: worstStatus(services.map((s) => s.status)),
    services,
  };
}

/** Metrics currently at warn/critical — the alert candidates. */
export function breachedServices(summary: UsageSummary): UsageServiceSummary[] {
  return summary.services.filter((s) => s.status === "warn" || s.status === "critical");
}

// Keep MASTER_BY_KEY referenced for potential label lookups by consumers/tests.
export { MASTER_BY_KEY };
