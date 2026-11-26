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
 *  Accepts `now` for deterministic tests; `stale` backdates the capture by 3 days so the
 *  "データが古い" state can be shown in demo (?usage-stale=1). */
export function buildMockUsageSummary(now: Date = new Date(), opts: { stale?: boolean } = {}): UsageSummary {
  const iso = (msFromNow: number): string => new Date(now.getTime() + msFromNow).toISOString();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const RUNBOOK = "https://github.com/KIT-DevelopersHub/dub-ecosystem/blob/main/docs/runbooks/11-usage-free-tier";
  const search = (key: string): string =>
    `https://github.com/KIT-DevelopersHub/dub-ecosystem/issues?q=${encodeURIComponent(`is:issue is:open label:area:usage in:title "[usage:${key}]"`)}`;
  const workersPaid = (price: string) => ({ name: "Workers Paid", price });

  return {
    generatedAt: now.toISOString(),
    capturedAt: opts.stale ? iso(-3 * DAY) : now.toISOString(),
    stale: opts.stale === true,
    // Roll-up = the worst leaf below (a critical metric is present).
    worstStatus: "critical",
    worstLevel: "critical",
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
        level: "ok", projection: { basis: "window", exhaustsAt: null, pctAtReset: 20.6, perDay: 20_575 }, playbookUrl: `${RUNBOOK}/workers-requests.md`, paidPlan: workersPaid("$5/月（1,000 万リクエスト/月込み、超過 $0.30/100 万）"), issueSearchUrl: search("workers_requests_day"),
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
        level: "warn", projection: { basis: "window", exhaustsAt: iso(4 * HOUR), pctAtReset: 126.7, perDay: 6_333_333 }, playbookUrl: `${RUNBOOK}/d1-rows-read.md`, paidPlan: workersPaid("$5/月（250 億行読み取り/月込み、超過 $0.001/100 万行）"), issueSearchUrl: search("d1_rows_read_day"),
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
        level: "critical", projection: { basis: "window", exhaustsAt: iso(HOUR), pctAtReset: 160.8, perDay: 160_833 }, playbookUrl: `${RUNBOOK}/kv.md`, paidPlan: workersPaid("$5/月（1,000 万読み取り/月込み、超過 $0.50/100 万）"), issueSearchUrl: search("kv_reads_day"),
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
        level: "act", projection: { basis: "growth", exhaustsAt: iso(5 * DAY), pctAtReset: null, perDay: 270_000_000 }, playbookUrl: `${RUNBOOK}/d1-storage.md`, paidPlan: workersPaid("$5/月（5 GB 込み、超過 $0.75/GB-月）"), issueSearchUrl: search("d1_storage"),
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
        level: "ok", projection: { basis: "window", exhaustsAt: null, pctAtReset: 57.1, perDay: 57 }, playbookUrl: `${RUNBOOK}/email-sending.md`, paidPlan: { name: "Resend Pro", price: "$20/月（5 万通/月）" }, issueSearchUrl: search("resend_emails_month"),
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
        level: "unknown", projection: null, playbookUrl: `${RUNBOOK}/kv.md`, paidPlan: workersPaid("$5/月（保存 1 GB 込み）"), issueSearchUrl: search("workers_kv_storage"),
      },
      {
        provider: "gcp",
        metricKey: "gcp_calendar_requests_peak_minute",
        label: "Google Calendar API リクエスト(ピーク/分)",
        used: 18,
        limit: 600,
        pct: 3.0,
        unit: "req/min",
        resetsAt: iso(18 * HOUR),
        overflowBehavior: "halt",
        status: "ok",
        level: "ok", projection: null, playbookUrl: `${RUNBOOK}/google-apis.md`, paidPlan: { name: "課金プランなし（クォータ引き上げ申請）", price: "$0" }, issueSearchUrl: search("gcp_calendar_requests_peak_minute"),
      },
      {
        provider: "gcp",
        metricKey: "gcp_meet_requests_peak_minute",
        label: "Google Meet API リクエスト(ピーク/分)",
        used: 6,
        limit: 600,
        pct: 1.0,
        unit: "req/min",
        resetsAt: iso(18 * HOUR),
        overflowBehavior: "halt",
        status: "ok",
        level: "ok", projection: null, playbookUrl: `${RUNBOOK}/google-apis.md`, paidPlan: { name: "課金プランなし（クォータ引き上げ申請）", price: "$0" }, issueSearchUrl: search("gcp_meet_requests_peak_minute"),
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
      level: "unknown",
      projection: null,
    })),
  };
}
