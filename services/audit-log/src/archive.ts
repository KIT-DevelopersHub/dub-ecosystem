// Monthly long-term archive (Cron Trigger). Moves records older than the retention
// window to R2 as NDJSON, then deletes them from D1 with plain DML (the conditional
// DELETE trigger guarantees only out-of-window rows can be removed).
import type { R2Bucket } from "@cloudflare/workers-types";
import type { DbClient } from "@dub/db";
import type { auditLog } from "@dub/types";
import { RETENTION_MONTHS, ARCHIVE_PREFIX } from "./config";
import { selectBefore, deleteBefore } from "./repo";

/** ISO cutoff = now minus RETENTION_MONTHS (UTC). Records older than this are archivable. */
export function retentionCutoffIso(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - RETENTION_MONTHS);
  return d.toISOString();
}

function monthKey(occurredAt: string): string {
  return occurredAt.slice(0, 7); // "YYYY-MM"
}

function toNdjson(records: auditLog.AuditRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export interface ArchiveSummary {
  cutoff: string;
  archived: number;
  months: string[];
}

/**
 * Archive+prune. Groups out-of-window records by month, writes one NDJSON object per
 * month to R2 (audit-archive/{YYYY-MM}.ndjson), then deletes the same window from D1.
 */
export async function archiveOldRecords(
  db: DbClient,
  bucket: R2Bucket,
  now: Date = new Date(),
): Promise<ArchiveSummary> {
  const cutoff = retentionCutoffIso(now);
  const records = await selectBefore(db, cutoff);
  if (records.length === 0) return { cutoff, archived: 0, months: [] };

  const byMonth = new Map<string, auditLog.AuditRecord[]>();
  for (const r of records) {
    const k = monthKey(r.occurredAt);
    (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(r);
  }

  const months = [...byMonth.keys()].sort();
  for (const m of months) {
    await bucket.put(`${ARCHIVE_PREFIX}/${m}.ndjson`, toNdjson(byMonth.get(m)!), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  }

  const deleted = await deleteBefore(db, cutoff);
  return { cutoff, archived: deleted, months };
}
