// Free-tier master — the STATIC source of truth for every metric we guard: its ceiling,
// unit, reset cadence and overflow behavior. Values are the 2026 Cloudflare Workers Free
// and Resend Free published limits.
//
// !! REQUIRES PERIODIC RE-CHECK !! These numbers are hard-coded from public 2026 pricing
// pages; Cloudflare/Resend can change free-tier ceilings. Each entry's `source` notes where
// it came from. If a limit moves, edit it here — nothing else depends on the literal value.
//
// overflowBehavior is "halt" for EVERY Cloudflare metric: on the Free plan Cloudflare
// returns 429/errors at the ceiling and NEVER auto-charges — a bill only starts after a
// manual upgrade to Paid. If/when a specific product is upgraded to Paid, flip that entry
// to "bill" (metered overage) so the dashboard reflects the real risk. Resend Free likewise
// stops sending at the ceiling (halt).
import type { GB } from "./units";
import { GIB } from "./units";
import { firstOfNextUtcMonth, nextUtcDay } from "./time";
import type { OverflowBehavior, Provider, ResetKind } from "./types";

export interface MetricDef {
  provider: Provider;
  /** stable machine key — also the usage_snapshot.metric_key and the CF-usage map key. */
  metricKey: string;
  /** JP dashboard label. */
  label: string;
  /** free-tier ceiling in `unit`. */
  limit: number;
  unit: string;
  overflowBehavior: OverflowBehavior;
  reset: ResetKind;
  /** provenance / re-check note (2026). */
  source: string;
}

// The guarded metric set. Order here is the display order in the summary.
export const MASTER: readonly MetricDef[] = [
  // ---- Workers ----
  {
    provider: "cloudflare",
    metricKey: "workers_requests_day",
    label: "Workers リクエスト(日)",
    limit: 100_000, // 100k requests/day (Workers Free). source: CF Workers pricing 2026 — re-check
    unit: "req/day",
    overflowBehavior: "halt",
    reset: "daily",
    source: "Cloudflare Workers Free: 100,000 requests/day (2026, re-check)",
  },
  // ---- D1 ----
  {
    provider: "cloudflare",
    metricKey: "d1_rows_read_day",
    label: "D1 行読み取り(日)",
    limit: 5_000_000, // 5M rows read/day (D1 Free). source: CF D1 pricing 2026 — re-check
    unit: "rows/day",
    overflowBehavior: "halt",
    reset: "daily",
    source: "Cloudflare D1 Free: 5,000,000 rows read/day (2026, re-check)",
  },
  {
    provider: "cloudflare",
    metricKey: "d1_rows_written_day",
    label: "D1 行書き込み(日)",
    limit: 100_000, // 100k rows written/day (D1 Free). source: CF D1 pricing 2026 — re-check
    unit: "rows/day",
    overflowBehavior: "halt",
    reset: "daily",
    source: "Cloudflare D1 Free: 100,000 rows written/day (2026, re-check)",
  },
  {
    provider: "cloudflare",
    metricKey: "d1_storage",
    label: "D1 ストレージ",
    limit: 5 * GIB, // 5 GB total stored (D1 Free). bytes. source: CF D1 pricing 2026 — re-check
    unit: "GB",
    overflowBehavior: "halt",
    reset: "none",
    source: "Cloudflare D1 Free: 5 GB storage (2026, re-check)",
  },
  // ---- KV ----
  {
    provider: "cloudflare",
    metricKey: "kv_reads_day",
    label: "KV 読み取り(日)",
    limit: 100_000, // 100k reads/day (KV Free). source: CF KV pricing 2026 — re-check
    unit: "reads/day",
    overflowBehavior: "halt",
    reset: "daily",
    source: "Cloudflare KV Free: 100,000 reads/day (2026, re-check)",
  },
  {
    provider: "cloudflare",
    metricKey: "kv_writes_day",
    label: "KV 書き込み(日)",
    limit: 1_000, // 1k writes/day (KV Free). source: CF KV pricing 2026 — re-check
    unit: "writes/day",
    overflowBehavior: "halt",
    reset: "daily",
    source: "Cloudflare KV Free: 1,000 writes/day (2026, re-check)",
  },
  // ---- R2 ----
  {
    provider: "cloudflare",
    metricKey: "r2_storage",
    label: "R2 ストレージ",
    limit: 10 * GIB, // 10 GB-month stored (R2 Free). bytes. source: CF R2 pricing 2026 — re-check
    unit: "GB",
    overflowBehavior: "halt",
    reset: "monthly",
    source: "Cloudflare R2 Free: 10 GB-month storage (2026, re-check)",
  },
  {
    provider: "cloudflare",
    metricKey: "r2_class_a_month",
    label: "R2 Class A 操作(月)",
    limit: 1_000_000, // 1M Class A ops/month (R2 Free). source: CF R2 pricing 2026 — re-check
    unit: "ops/month",
    overflowBehavior: "halt",
    reset: "monthly",
    source: "Cloudflare R2 Free: 1,000,000 Class A ops/month (2026, re-check)",
  },
  {
    provider: "cloudflare",
    metricKey: "r2_class_b_month",
    label: "R2 Class B 操作(月)",
    limit: 10_000_000, // 10M Class B ops/month (R2 Free). source: CF R2 pricing 2026 — re-check
    unit: "ops/month",
    overflowBehavior: "halt",
    reset: "monthly",
    source: "Cloudflare R2 Free: 10,000,000 Class B ops/month (2026, re-check)",
  },
  // ---- Durable Objects ----
  {
    provider: "cloudflare",
    metricKey: "do_requests_day",
    label: "Durable Objects リクエスト(日)",
    limit: 100_000, // 100k requests/day (DO Free, SQLite-backed). source: CF DO pricing 2026 — re-check
    unit: "req/day",
    overflowBehavior: "halt",
    reset: "daily",
    source: "Cloudflare Durable Objects Free: 100,000 requests/day (2026, re-check)",
  },
  // ---- Resend (transactional email) ----
  {
    provider: "resend",
    metricKey: "resend_emails_day",
    label: "メール送信(日)",
    limit: 100, // 100 emails/day (Resend Free). source: Resend pricing 2026 — re-check
    unit: "emails/day",
    overflowBehavior: "halt",
    reset: "daily",
    source: "Resend Free: 100 emails/day (2026, re-check)",
  },
  {
    provider: "resend",
    metricKey: "resend_emails_month",
    label: "メール送信(月)",
    limit: 3_000, // 3000 emails/month (Resend Free). source: Resend pricing 2026 — re-check
    unit: "emails/month",
    overflowBehavior: "halt",
    reset: "monthly",
    source: "Resend Free: 3,000 emails/month (2026, re-check)",
  },
];

/** Fast lookup by metric key. */
export const MASTER_BY_KEY: ReadonlyMap<string, MetricDef> = new Map(MASTER.map((m) => [m.metricKey, m]));

/** The ISO8601 instant a metric's window next resets, or null for cumulative (none). */
export function resetAt(reset: ResetKind, now: Date): string | null {
  if (reset === "daily") return nextUtcDay(now).toISOString();
  if (reset === "monthly") return firstOfNextUtcMonth(now).toISOString();
  return null;
}

// re-export so callers can format bytes->GB consistently
export type { GB };
