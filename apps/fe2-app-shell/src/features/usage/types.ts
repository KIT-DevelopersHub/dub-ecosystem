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
 *  ok = comfortable · warn ≥70% · critical ≥90% · unknown = could not be read. */
export type UsageStatus = "ok" | "warn" | "critical" | "unknown";

/** What the upstream does when the quota is exceeded.
 *  halt = request is rejected (HTTP 429), NO automatic charge (Cloudflare free).
 *  bill = usage past the quota is billed (a Paid/metered plan). */
export type OverflowBehavior = "halt" | "bill";

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
}

/** GET /usage/summary response. */
export interface UsageSummary {
  /** ISO-8601 instant the snapshot was produced. */
  generatedAt: string;
  /** Worst status across all services — drives the page-level banner. */
  worstStatus: UsageStatus;
  services: ServiceUsage[];
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
 *  forbidden = the caller lacks infra:read (or the session lapsed); error = a
 *  transient/offline/contract failure. */
export type UsageUnavailableReason = "forbidden" | "error";

export interface UsageSummaryResult {
  /** Always present so screens can map a stable card layout. For `unavailable`
   *  this is a NEUTRAL summary (all statuses `unknown`, no percentages). */
  summary: UsageSummary;
  source: UsageSource;
  /** Set only when `source === "unavailable"`. */
  reason?: UsageUnavailableReason;
}
