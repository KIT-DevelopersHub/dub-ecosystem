// Documented mock for GET /usage/summary. This is the fallback the dashboard shows
// when the live gateway is unreachable AND the seed used by demo builds (VITE_DEMO).
// It deliberately spans every visual state the UI must handle:
//   status:  ok / warn / critical / unknown
//   overflowBehavior: halt (Cloudflare free) / bill (metered plan)
//   resetsAt: rolling window / null (no rollover)
// Keeping it here (not in tests) means the component tree renders a full, realistic
// board with the backend absent, and the same fixture backs both the unit tests and
// the demo transport — one source of truth for "what a healthy-ish snapshot looks
// like". Values are illustrative, not real quotas.
import type { UsageSummary } from "./types.ts";

/** Build the mock relative to a fixed base instant so resets read sensibly.
 *  Accepts `now` for deterministic tests. */
export function buildMockUsageSummary(now: Date = new Date()): UsageSummary {
  const iso = (msFromNow: number): string => new Date(now.getTime() + msFromNow).toISOString();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  return {
    generatedAt: now.toISOString(),
    // Roll-up = the worst leaf below (a critical metric is present).
    worstStatus: "critical",
    services: [
      {
        provider: "cloudflare",
        metricKey: "workers_requests_day",
        label: "Workers リクエスト(日)",
        used: 12_345,
        limit: 100_000,
        pct: 12.3,
        unit: "req/day",
        resetsAt: iso(18 * HOUR),
        overflowBehavior: "halt",
        status: "ok",
      },
      {
        provider: "cloudflare",
        metricKey: "d1_rows_read_day",
        label: "D1 行読み取り(日)",
        used: 3_800_000,
        limit: 5_000_000,
        pct: 76.0,
        unit: "rows/day",
        resetsAt: iso(18 * HOUR),
        overflowBehavior: "halt",
        status: "warn",
      },
      {
        provider: "cloudflare",
        metricKey: "kv_reads_day",
        label: "KV 読み取り(日)",
        used: 96_500,
        limit: 100_000,
        pct: 96.5,
        unit: "reads/day",
        resetsAt: iso(18 * HOUR),
        overflowBehavior: "halt",
        status: "critical",
      },
      {
        // Storage metric: no rollover window (resetsAt null) and a byte unit the UI
        // renders as human GB. The backend now collects D1 storage, so demo mode shows
        // the full metric set including a storage-type line.
        provider: "cloudflare",
        metricKey: "d1_storage",
        label: "D1 ストレージ",
        used: 3_650_000_000,
        limit: 5_000_000_000,
        pct: 73.0,
        unit: "bytes",
        resetsAt: null,
        overflowBehavior: "halt",
        status: "warn",
      },
      {
        provider: "resend",
        metricKey: "emails_month",
        label: "メール送信(月)",
        used: 1_200,
        limit: 3_000,
        pct: 40.0,
        unit: "emails/month",
        resetsAt: iso(9 * DAY),
        overflowBehavior: "bill",
        status: "ok",
      },
      {
        provider: "cloudflare",
        metricKey: "workers_kv_storage",
        label: "KV ストレージ",
        used: 0,
        limit: 1_073_741_824,
        pct: 0,
        unit: "bytes",
        resetsAt: null,
        overflowBehavior: "bill",
        status: "unknown",
      },
      {
        // Future provider (backend is adding "gcp" to the union). Demo includes it so
        // the [GCP] section renders and unknown-provider grouping is exercised.
        provider: "gcp",
        metricKey: "gcp_logging_ingest_month",
        label: "Cloud Logging 取り込み(月)",
        used: 12_000_000_000,
        limit: 50_000_000_000,
        pct: 24.0,
        unit: "bytes",
        resetsAt: iso(9 * DAY),
        overflowBehavior: "bill",
        status: "ok",
      },
    ],
  };
}

/** Convenience constant (current-time based) for non-deterministic callers. */
export const MOCK_USAGE_SUMMARY: UsageSummary = buildMockUsageSummary();

/** NEUTRAL summary for the "could not read" state (live GET failed / forbidden /
 *  malformed). It reuses ONLY the metric catalog (labels/providers/units/overflow
 *  behaviour) from the mock, but blanks every usage value: status `unknown`, no
 *  percentage, amounts unreadable, worst-status `unknown`. This lets the dashboard
 *  render the familiar card grid as "取得不可 / —" WITHOUT ever showing the mock's
 *  illustrative warn/critical numbers — so a degraded/unauthorized session never
 *  sees a fake "上限間近" alarm. */
export function buildNeutralUsageSummary(now: Date = new Date()): UsageSummary {
  const base = buildMockUsageSummary(now);
  return {
    generatedAt: now.toISOString(),
    worstStatus: "unknown",
    services: base.services.map((s) => ({
      ...s,
      used: -1,
      limit: -1,
      pct: Number.NaN,
      resetsAt: null,
      status: "unknown",
    })),
  };
}
