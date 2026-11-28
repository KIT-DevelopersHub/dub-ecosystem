// Free-tier usage & billing-guard — SHARED JSON CONTRACT (GET /usage/summary).
//
// This mirrors, field-for-field, the wire shape the backend agent is implementing
// for `GET /usage/summary` (gateway path: /api/v1/usage/summary). The frontend
// treats this file as the single source of truth for the response shape and MUST
// NOT diverge from it — if the backend needs a new field, extend the contract on
// both sides, never fork it here.
//
// Purpose of the feature: give operators an at-a-glance read on how close each
// free-tier quota (Cloudflare Workers/D1/…, Resend email) is to its ceiling, and
// what happens on overflow — so the REAL risk (a service silently *halting* at the
// free-tier wall) is caught early. Cloudflare's free plan stops at the limit and
// does NOT auto-bill; billing only happens on a manual Paid upgrade.

/** Upstream provider whose quota is being metered. Open-ended by contract intent
 *  (new providers may appear); the two shipped today are cloudflare & resend. */
export type ServiceProvider = "cloudflare" | "resend" | (string & {});

/** Per-metric health. Drives the status color and worst-status roll-up.
 *  ok = comfortable · warn / critical by pct · unknown = could not be read. */
export type UsageStatus = "ok" | "warn" | "critical" | "unknown";

/** What the upstream does when the quota is exceeded.
 *  halt = request is rejected (HTTP 429), NO automatic charge (Cloudflare free).
 *  bill = usage past the quota is billed (a Paid/metered plan). */
export type OverflowBehavior = "halt" | "bill";

/** Escalation ladder (#902): warn · act · critical (LEVEL_PCT), raised when the current
 *  pace runs out before the reset. Drives the GitHub Issue flow (area:usage). */
export type EscalationLevel = "ok" | "warn" | "act" | "critical" | "unknown";

/** Run-out estimate at the current pace (usage-meter escalation.ts). */
export interface UsageProjection {
  /** window = pace inside the daily/monthly window; growth = day-over-day storage growth. */
  basis: "window" | "growth";
  /** When the ceiling is reached at this pace; null = not before the reset / not within a year. */
  exhaustsAt: string | null;
  /** Window basis: projected % at the reset. */
  pctAtReset: number | null;
  /** Pace in the metric's unit per day. */
  perDay: number;
}

/** One metered quota line (e.g. "Workers requests / day"). */
export interface ServiceUsage {
  provider: ServiceProvider;
  /** Stable machine key, e.g. "workers_requests_day". */
  metricKey: string;
  /** Human label (ja), e.g. "Workers リクエスト(日)". */
  label: string;
  /** Amount consumed in the current window. */
  used: number;
  /** Quota ceiling for the window. */
  limit: number;
  /** Percentage used (0–100, one-decimal precision on the wire). */
  pct: number;
  /** Unit suffix for used/limit, e.g. "req/day", "emails/month". */
  unit: string;
  /** ISO-8601 instant the window resets, or null when it does not roll over. */
  resetsAt: string | null;
  overflowBehavior: OverflowBehavior;
  status: UsageStatus;
  // Additive (#902) — absent from backends that predate it.
  level?: EscalationLevel;
  projection?: UsageProjection | null;
  /** Runbook: causes, how to find the top consumers, mitigations, when to pay. */
  playbookUrl?: string;
  /** What paying would cost for this product (a human decides). */
  paidPlan?: { name: string; price: string };
  /** GitHub search for this metric's open escalation Issue. */
  issueSearchUrl?: string;
}

/** GET /usage/summary response. */
export interface UsageSummary {
  /** ISO-8601 instant the response was produced (NOT when the numbers were measured). */
  generatedAt: string;
  /** ISO-8601 instant the numbers were collected; null = never collected. Absent from
   *  backends that predate the field. */
  capturedAt?: string | null;
  /** The numbers are older than 48h (collection has stopped) — show them as old, not current. */
  stale?: boolean;
  /** Worst status across all services — drives the page-level banner. */
  worstStatus: UsageStatus;
  /** Highest escalation level (#902). */
  worstLevel?: EscalationLevel;
  services: ServiceUsage[];
}

/** An open escalation Issue on GitHub (title prefix `[usage:<metricKey>]`). */
export interface UsageIssue {
  metricKey: string;
  number: number;
  url: string;
  title: string;
}

/** Open Issues keyed by metricKey; `available:false` = GitHub could not be read. */
export interface UsageIssuesResult {
  available: boolean;
  byMetric: Record<string, UsageIssue>;
}

/** Where the currently-shown summary came from.
 *  - live        = real GET /usage/summary payload.
 *  - demo        = VITE_DEMO build seed (mock; dev/demo only).
 *  - unavailable = the live read failed / was forbidden / was malformed. The UI
 *                  must render a NEUTRAL "取得できませんでした" state here — never the
 *                  mock's illustrative warn/critical numbers, which would falsely
 *                  look like the account is near its ceiling. */
export type UsageSource = "live" | "demo" | "unavailable";

/** Why a summary is `unavailable` — drives the neutral notice copy.
 *  forbidden = the caller is not authenticated / the session lapsed (viewing needs
 *  sign-in but no special permission); error = a transient/offline/contract failure. */
export type UsageUnavailableReason = "forbidden" | "error";

export interface UsageSummaryResult {
  /** Always present so screens can map a stable card layout. For `unavailable`
   *  this is a NEUTRAL summary (all statuses `unknown`, no percentages). */
  summary: UsageSummary;
  source: UsageSource;
  /** Set only when `source === "unavailable"`. */
  reason?: UsageUnavailableReason;
}
