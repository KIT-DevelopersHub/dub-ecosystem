// Build the frozen GET /usage/summary contract from snapshot rows. Iterates the MASTER so
// the metric set + display order are stable and always complete: a metric with no snapshot
// row (never collected) renders as status="unknown" with null used/pct. resetsAt is computed
// at read time from the metric's reset cadence relative to `now`.
// #902 adds, per metric, the escalation level + run-out projection + playbook/paid-plan links.
import { isEscalated, levelFor, levelRank, projectUsage, type EscalationLevel, type HistoryPoint } from "./escalation";
import { isStale } from "./freshness";
import { MASTER, MASTER_BY_KEY, resetAt } from "./limits";
import { DEFAULT_ALERT_REPO, playbookFor, playbookUrl, resolveAlertRepo } from "./playbook";
import { worstStatus } from "./thresholds";
import type { SnapshotRow, UsageServiceSummary, UsageStatus, UsageSummary } from "./types";

/** Stable title prefix of a metric's escalation Issue (the dedup key on GitHub). */
export function issueTitlePrefix(metricKey: string): string {
  return `[usage:${metricKey}]`;
}

/** Search link in the (private) alert repo; `repo` is USAGE_ALERT_REPO (refused -> default). */
export function issueSearchUrl(metricKey: string, repo?: string | null): string {
  const q = `is:issue is:open label:area:usage in:title "${issueTitlePrefix(metricKey)}"`;
  return `https://github.com/${resolveAlertRepo(repo) ?? DEFAULT_ALERT_REPO}/issues?q=${encodeURIComponent(q)}`;
}

/** metricKey -> earlier daily readings (only storage metrics need it, for growth). */
export type UsageHistory = ReadonlyMap<string, readonly HistoryPoint[]>;

/** `capturedAt` = when `rows` were collected (null = never); it drives the stale flag. */
export function buildSummary(
  rows: readonly SnapshotRow[],
  now: Date,
  capturedAt: string | null,
  history: UsageHistory = new Map(),
  alertRepo?: string | null,
): UsageSummary {
  const byKey = new Map(rows.map((r) => [r.metric_key, r]));

  const services: UsageServiceSummary[] = MASTER.map((def) => {
    const row = byKey.get(def.metricKey);
    const status: UsageStatus = row ? row.status : "unknown";
    const used = row ? row.used : null;
    const pct = row ? row.pct : null;
    const at = new Date(row?.captured_at ?? capturedAt ?? now.toISOString());
    const projection = row && status !== "unknown" ? projectUsage(def, used, at, history.get(def.metricKey)) : null;
    const pb = playbookFor(def.metricKey);
    return {
      provider: def.provider,
      metricKey: def.metricKey,
      label: def.label,
      used,
      limit: def.limit,
      pct,
      unit: def.unit,
      resetsAt: resetAt(def.reset, now),
      overflowBehavior: def.overflowBehavior,
      status,
      level: status === "unknown" ? "unknown" : levelFor(pct, projection, at),
      projection,
      playbookUrl: playbookUrl(def.metricKey),
      paidPlan: { name: pb.paid.name, price: pb.paid.price },
      issueSearchUrl: issueSearchUrl(def.metricKey, alertRepo),
    };
  });

  let worstLevel: EscalationLevel = "ok";
  for (const s of services) if (levelRank(s.level) > levelRank(worstLevel)) worstLevel = s.level;
  if (services.length > 0 && services.every((s) => s.level === "unknown")) worstLevel = "unknown";

  return {
    generatedAt: now.toISOString(),
    capturedAt,
    stale: isStale(capturedAt, now),
    worstStatus: worstStatus(services.map((s) => s.status)),
    worstLevel,
    services,
  };
}

/** Metrics at warn/act/critical (incl. projection-raised) — the alert/Issue candidates. */
export function breachedServices(summary: UsageSummary): UsageServiceSummary[] {
  return summary.services.filter((s) => isEscalated(s.level));
}

// Keep MASTER_BY_KEY referenced for potential label lookups by consumers/tests.
export { MASTER_BY_KEY };
