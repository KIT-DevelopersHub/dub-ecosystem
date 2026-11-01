// Daily row-count snapshot + decrease alert (データ保全 Phase 1). Mail is kept
// indefinitely, so COUNT(*) of mail_inbound / mail_send_log must never go down; if it
// does, something deleted mail (the 2026-10 30-day purge went unnoticed for a month).
// Runs from the 5-minute cron but does the COUNT(*) only once per UTC day (the first tick
// that finds no snapshot for today). Never throws — it must not block the 予約送信 drain.
import { publishAudit } from "@dub/events";
import { nowIso, type DbClient } from "@dub/db";
import type { RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { SERVICE_NAME } from "./config";
import type { AuditEnv } from "./types";

export const WATCHED_TABLES = ["mail_inbound", "mail_send_log"] as const;
export type WatchedTable = (typeof WATCHED_TABLES)[number];

export interface RowCountDecrease {
  table: WatchedTable;
  previousDate: string;
  previousCount: number;
  count: number;
}

export interface RowCountSnapshotResult {
  date: string;
  recorded: WatchedTable[]; // tables snapshotted on this call ([] = already done today)
  decreases: RowCountDecrease[];
}

export interface RowCountDeps {
  db: DbClient;
  audit: AuditEnv;
  orgId: string;
  ctx: RequestContext;
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function runRowCountSnapshot(deps: RowCountDeps, now: number = Date.now()): Promise<RowCountSnapshotResult> {
  const date = utcDate(now);
  const out: RowCountSnapshotResult = { date, recorded: [], decreases: [] };
  try {
    for (const table of WATCHED_TABLES) {
      const done = await deps.db.first<{ c: number }>(
        `SELECT 1 AS c FROM mail_row_count_snapshots WHERE snapshot_date = ? AND table_name = ?`,
        date,
        table,
      );
      if (done) continue;
      // table is a closed literal from WATCHED_TABLES, never input.
      const counted = await deps.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
      const count = Number(counted?.c ?? 0);
      const ts = nowIso();
      const res = await deps.db.run(
        `INSERT OR IGNORE INTO mail_row_count_snapshots (snapshot_date, table_name, row_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        date,
        table,
        count,
        ts,
        ts,
      );
      if (res.meta.changes === 0) continue; // a concurrent tick won the day
      out.recorded.push(table);
      const prev = await deps.db.first<{ snapshot_date: string; row_count: number }>(
        `SELECT snapshot_date, row_count FROM mail_row_count_snapshots
          WHERE table_name = ? AND snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1`,
        table,
        date,
      );
      if (prev && count < prev.row_count) {
        const d: RowCountDecrease = { table, previousDate: prev.snapshot_date, previousCount: prev.row_count, count };
        out.decreases.push(d);
        await alertDecrease(deps, d, date);
      }
    }
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-gateway: row-count snapshot failed",
      service: SERVICE_NAME,
      requestId: deps.ctx.requestId,
      fields: { date, error: err instanceof Error ? err.message : String(err) },
    });
  }
  return out;
}

async function alertDecrease(deps: RowCountDeps, d: RowCountDecrease, date: string): Promise<void> {
  const fields = { ...d, date, lost: d.previousCount - d.count };
  consoleSink({
    level: "error",
    message: "mail-gateway: ALERT mail row count decreased (possible data loss)",
    service: SERVICE_NAME,
    requestId: deps.ctx.requestId,
    fields,
  });
  try {
    await publishAudit(deps.audit, {
      action: "mail.data.row_count_decreased",
      actorId: null,
      orgId: deps.orgId,
      result: "failure",
      resourceType: "mail_table",
      resourceId: d.table,
      details: fields,
      requestId: deps.ctx.requestId,
      occurredAt: nowIso(),
    });
  } catch {
    // best-effort; the console record above already carries the alert.
  }
}
