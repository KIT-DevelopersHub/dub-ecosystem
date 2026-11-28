// D1 persistence for usage_snapshot. Two namespace-scoped clients over the SAME shared
// dub-core DB: a "usage" client for our own writes/reads, and a read-only "mail" client
// for the Resend send-log COUNT. Daily UPSERT keyed on (provider, metric_key, capture_day).
import { createDbClient, newId, nowIso, type DbClient } from "@dub/db";
import type { D1Database } from "@cloudflare/workers-types";
import { projectionBasis, type HistoryPoint } from "./escalation";
import { MASTER } from "./limits";
import type { UsageHistory } from "./summary";
import { DAY_MS, utcDayString } from "./time";
import type { SnapshotRow } from "./types";

/** Our own namespace client (usage_ writes + reads). */
export function usageDb(db: D1Database, requestId?: string): DbClient {
  return createDbClient(db, { namespace: "usage", ...(requestId ? { requestId } : {}) });
}

/** Read-only client for the Resend send-log COUNT (mail_ namespace, cross-service READ). */
export function mailReadDb(db: D1Database, requestId?: string): DbClient {
  return createDbClient(db, { namespace: "mail", ...(requestId ? { requestId } : {}) });
}

/** UPSERT today's snapshot rows (one per metric). Idempotent within a UTC day.
 *  UPDATE-then-INSERT rather than "ON CONFLICT DO UPDATE SET": the @dub/db namespace guard
 *  parses the token after "UPDATE", and in "DO UPDATE SET" that token is "SET" (a false
 *  cross-namespace hit). `UPDATE usage_snapshot SET ...` keeps the table token correct. */
export async function upsertSnapshot(db: DbClient, rows: readonly SnapshotRow[], now: Date): Promise<void> {
  const day = utcDayString(now);
  const ts = nowIso();
  for (const r of rows) {
    const upd = await db.run(
      `UPDATE usage_snapshot
          SET captured_at = ?, label = ?, used = ?, limit_value = ?, pct = ?, unit = ?, overflow_behavior = ?, status = ?, updated_at = ?
        WHERE provider = ? AND metric_key = ? AND capture_day = ?`,
      ts,
      r.label,
      r.used,
      r.limit_value,
      r.pct,
      r.unit,
      r.overflow_behavior,
      r.status,
      ts,
      r.provider,
      r.metric_key,
      day,
    );
    if (upd.meta.changes === 0) {
      await db.run(
        `INSERT OR IGNORE INTO usage_snapshot
           (id, capture_day, captured_at, provider, metric_key, label, used, limit_value, pct, unit, overflow_behavior, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId("usage"),
        day,
        ts,
        r.provider,
        r.metric_key,
        r.label,
        r.used,
        r.limit_value,
        r.pct,
        r.unit,
        r.overflow_behavior,
        r.status,
        ts,
        ts,
      );
    }
  }
}

/** When the latest snapshot was collected (MAX captured_at), or null if none ever was. */
export async function readLatestCapturedAt(db: DbClient): Promise<string | null> {
  // usage/0002 index on captured_at turns this MAX into a 1-row index probe (was a full scan).
  const row = await db.first<{ last: string | null }>(`SELECT MAX(captured_at) AS last FROM usage_snapshot`);
  return row?.last ?? null;
}

/** How many days back a metric's last KNOWN value may be surfaced before it is allowed to
 *  go "unknown". Bounds how stale a carried-forward reading can be (see readLatestSnapshot). */
const KNOWN_VALUE_LOOKBACK_DAYS = 7;

/** Read the freshest USABLE snapshot: per metric, the most recent day whose reading is NOT
 *  "unknown", within a bounded lookback of the latest capture day. Empty array when nothing
 *  usable was ever collected.
 *
 *  WHY not simply "the latest capture_day": collection can transiently fail for one provider
 *  (e.g. a Cloudflare GraphQL 5xx/timeout writes that day's CF rows as status="unknown"). If
 *  the read took only MAX(capture_day), that single blip would blank EVERY Cloudflare card to
 *  "取得不可" even though yesterday's real values are one row away — the exact production bug
 *  this fixes. Instead each metric independently surfaces its last known-good reading, so an
 *  intermittent upstream hiccup degrades to a slightly-stale number, never to a blank board.
 *  A metric with no known value inside the lookback is simply omitted → buildSummary renders
 *  it "unknown" (genuinely un-collectable, not a transient blip). */
export async function readLatestSnapshot(db: DbClient): Promise<SnapshotRow[]> {
  const rows = await db.all<{
    provider: SnapshotRow["provider"];
    metric_key: string;
    label: string;
    used: number | null;
    limit_value: number;
    pct: number | null;
    unit: string;
    overflow_behavior: SnapshotRow["overflow_behavior"];
    status: SnapshotRow["status"];
    captured_at: string;
  }>(
    // Per metric, the latest known day inside the lookback (one GROUP BY over the window via
    // idx_usage_snapshot_day; the unary + keeps the planner off the (provider, metric_key, day)
    // index, which would walk the whole table to avoid a sort), then one unique-index probe per metric for that day's row.
    // Was a correlated MAX per outer row (~8 index rows each), ~2k rows read per call.
    `SELECT s.provider, s.metric_key, s.label, s.used, s.limit_value, s.pct, s.unit, s.overflow_behavior, s.status, s.captured_at
       FROM (
         SELECT provider, metric_key, MAX(capture_day) AS day
           FROM usage_snapshot
          WHERE status != 'unknown'
            AND capture_day >= (SELECT date(MAX(capture_day), '-${KNOWN_VALUE_LOOKBACK_DAYS} days') FROM usage_snapshot)
          GROUP BY +provider, +metric_key
       ) b
       JOIN usage_snapshot s
         ON s.provider = b.provider AND s.metric_key = b.metric_key AND s.capture_day = b.day`,
  );
  return rows.map((r) => ({
    provider: r.provider,
    metric_key: r.metric_key,
    label: r.label,
    used: r.used,
    limit_value: r.limit_value,
    pct: r.pct,
    unit: r.unit,
    overflow_behavior: r.overflow_behavior,
    status: r.status,
    captured_at: r.captured_at,
  }));
}

/** Days of history the storage growth projection looks back over. */
export const GROWTH_LOOKBACK_DAYS = 7;

/** Earlier daily readings of the GROWTH metrics only (D1/R2 storage), for the run-out
 *  projection. Unique-index range probe: at most (growth metrics x 8 days) rows (~16). */
export async function readGrowthHistory(db: DbClient, now: Date): Promise<UsageHistory> {
  const defs = MASTER.filter((d) => projectionBasis(d) === "growth");
  const out = new Map<string, HistoryPoint[]>();
  if (defs.length === 0) return out;
  const since = utcDayString(new Date(now.getTime() - GROWTH_LOOKBACK_DAYS * DAY_MS));
  const where = defs.map(() => "(provider = ? AND metric_key = ? AND capture_day >= ?)").join(" OR ");
  const args = defs.flatMap((d) => [d.provider, d.metricKey, since]);
  const rows = await db.all<{ metric_key: string; capture_day: string; used: number | null }>(
    `SELECT metric_key, capture_day, used FROM usage_snapshot WHERE (${where}) AND status != 'unknown'`,
    ...args,
  );
  for (const r of rows) {
    if (r.used === null) continue;
    const list = out.get(r.metric_key) ?? [];
    list.push({ day: r.capture_day, used: r.used });
    out.set(r.metric_key, list);
  }
  return out;
}
