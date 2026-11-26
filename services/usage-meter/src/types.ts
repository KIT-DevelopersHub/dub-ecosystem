// Shared types for the free-tier usage meter / billing guard. The UsageSummary shape is
// the FROZEN JSON contract shared with the fe2 dashboard — do not change field names or
// the status/overflow vocabularies without updating the frontend in lockstep.

import type { EscalationLevel, UsageProjection } from "./escalation";

export type { EscalationLevel, UsageProjection };

// "gcp" = the Google APIs behind カレンダー (Calendar, Meet REST). The Provider union is additive.
export type Provider = "cloudflare" | "resend" | "gcp";

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
  // ---- additive (#902): escalation ladder + what to do about it ----
  /** ok / warn>=70 / act>=85 / critical>=95, raised by the projection (see escalation.ts). */
  level: EscalationLevel;
  /** Run-out estimate at the current pace; null when it cannot be estimated. */
  projection: UsageProjection | null;
  /** Runbook for this metric (causes, top-consumer queries, mitigations, when to pay). */
  playbookUrl: string;
  /** What paying would cost for this product (a human decides; nothing auto-upgrades). */
  paidPlan: { name: string; price: string };
  /** GitHub search for this metric's open escalation Issue (title prefix `[usage:<key>]`). */
  issueSearchUrl: string;
}

/** The GET /usage/summary response (frozen contract). */
export interface UsageSummary {
  generatedAt: string;
  /** When the shown numbers were collected (latest usage_snapshot.captured_at); null when
   *  nothing was ever collected. generatedAt is only the response time. */
  capturedAt: string | null;
  /** capturedAt is missing or older than 48h — the dashboard must say the data is old. */
  stale: boolean;
  worstStatus: UsageStatus;
  /** Highest escalation level across services (#902, additive). */
  worstLevel: EscalationLevel;
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
  /** When this row was collected (present on reads; absent on a fresh in-memory collect). */
  captured_at?: string;
}
