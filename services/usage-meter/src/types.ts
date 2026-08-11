// Shared types for the free-tier usage meter / billing guard. The UsageSummary shape is
// the FROZEN JSON contract shared with the fe2 dashboard — do not change field names or
// the status/overflow vocabularies without updating the frontend in lockstep.

export type Provider = "cloudflare" | "resend";

/** What happens when a metric crosses 100% of its free-tier ceiling.
 *  halt = the platform 429s / stops (no surprise bill; Cloudflare Free default).
 *  bill = metered/overage billing kicks in (only after a manual Paid upgrade). */
export type OverflowBehavior = "halt" | "bill";

/** ok < 70% ; warn >= 70% ; critical >= 90% ; unknown = usage could not be measured. */
export type UsageStatus = "ok" | "warn" | "critical" | "unknown";

/** How the metric's usage window resets (drives resetsAt). none = cumulative (e.g. storage). */
export type ResetKind = "daily" | "monthly" | "none";

/** One metric line in the summary (the frozen wire item). `used`/`pct` are null when the
 *  metric's usage could not be measured (status="unknown") — the dashboard must handle null. */
export interface UsageServiceSummary {
  provider: Provider;
  metricKey: string;
  label: string;
  used: number | null;
  limit: number;
  pct: number | null;
  unit: string;
  resetsAt: string | null;
  overflowBehavior: OverflowBehavior;
  status: UsageStatus;
}

/** The GET /usage/summary response (frozen contract). */
export interface UsageSummary {
  generatedAt: string;
  worstStatus: UsageStatus;
  services: UsageServiceSummary[];
}

/** A persisted usage_snapshot row (D1 shape; snake_case mirrors the DDL). */
export interface SnapshotRow {
  provider: Provider;
  metric_key: string;
  label: string;
  used: number | null;
  limit_value: number;
  pct: number | null;
  unit: string;
  overflow_behavior: OverflowBehavior;
  status: UsageStatus;
}
