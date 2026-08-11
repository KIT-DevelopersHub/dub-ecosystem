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
    ],
  };
}

/** Convenience constant (current-time based) for non-deterministic callers. */
export const MOCK_USAGE_SUMMARY: UsageSummary = buildMockUsageSummary();
