// Destructive-operation guard (データ保全 Phase 1). The ONLY place in mail-gateway allowed
// to physically delete mail rows; test/destructive-guard.test.ts fails the build if a raw
// `DELETE FROM mail_…` appears anywhere else in src/. Three locks, in order:
//   1. off by default — refused unless MAIL_DESTRUCTIVE_OPS === "on" (owner-approved op);
//   2. dry-run first — the matching row count is logged before anything changes;
//   3. two-stage — matching rows get deleted_at stamped; only rows soft-deleted longer than
//      the grace period (default 30 days, like a Trash) are physically removed.
import type { DbClient } from "@dub/db";
import { consoleSink } from "@dub/observability";
import { SERVICE_NAME } from "./config";

/** Tables that carry deleted_at (0016). A closed set: never interpolate caller input. */
export const GUARDED_TABLES = ["mail_inbound", "mail_send_log"] as const;
export type GuardedTable = (typeof GUARDED_TABLES)[number];

export const DEFAULT_SOFT_DELETE_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown when a bulk delete is attempted without the explicit opt-in flag. */
export class DestructiveOpRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestructiveOpRefused";
  }
}

export function destructiveOpsEnabled(flag: string | undefined): boolean {
  return flag === "on";
}

export interface BulkDeleteSpec {
  table: GuardedTable;
  /** SQL predicate selecting the rows to delete, with `?` placeholders (no user text). */
  where: string;
  binds?: unknown[];
  /** Why — logged with the dry-run count. */
  reason: string;
  graceDays?: number;
  now?: number;
}

export interface BulkDeleteResult {
  matched: number; // dry-run count of rows matching `where`
  softDeleted: number; // newly stamped deleted_at
  purged: number; // physically removed (soft-deleted longer than the grace period)
}

export async function guardedBulkDelete(db: DbClient, flag: string | undefined, spec: BulkDeleteSpec): Promise<BulkDeleteResult> {
  if (!destructiveOpsEnabled(flag)) {
    throw new DestructiveOpRefused(`bulk delete of ${spec.table} refused: MAIL_DESTRUCTIVE_OPS is not "on"`);
  }
  if (!(GUARDED_TABLES as readonly string[]).includes(spec.table)) {
    throw new DestructiveOpRefused(`bulk delete refused: ${spec.table} is not a guarded table`);
  }
  const binds = spec.binds ?? [];
  const now = spec.now ?? Date.now();
  const graceDays = spec.graceDays ?? DEFAULT_SOFT_DELETE_GRACE_DAYS;
  const cutoff = new Date(now - graceDays * DAY_MS).toISOString();

  const counted = await db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${spec.table} WHERE (${spec.where})`, ...binds);
  const matched = Number(counted?.c ?? 0);
  consoleSink({
    level: "warn",
    message: "mail-gateway: guarded bulk delete (dry-run count)",
    service: SERVICE_NAME,
    fields: { table: spec.table, reason: spec.reason, matched, graceDays },
  });

  const soft = await db.run(
    `UPDATE ${spec.table} SET deleted_at = ? WHERE deleted_at IS NULL AND (${spec.where})`,
    new Date(now).toISOString(),
    ...binds,
  );
  const hard = await db.run(
    `DELETE FROM ${spec.table} WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND (${spec.where})`,
    cutoff,
    ...binds,
  );
  const result = { matched, softDeleted: soft.meta.changes, purged: hard.meta.changes };
  consoleSink({
    level: "warn",
    message: "mail-gateway: guarded bulk delete done",
    service: SERVICE_NAME,
    fields: { table: spec.table, reason: spec.reason, ...result },
  });
  return result;
}
