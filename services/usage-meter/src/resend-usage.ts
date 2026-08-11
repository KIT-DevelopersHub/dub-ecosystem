// Resend email usage = COUNT of successfully-sent rows in mail-gateway's outbound send
// log (mail_send_log). Self-hosted, no external Resend API call — the send log IS the
// source of truth for how many emails we have sent today / this month. Read-only.
//
// The count uses a "mail"-namespaced DbClient (cross-service READ of the shared dub-core
// DB): we only SELECT COUNT, never write outside our own usage_ namespace.
import type { DbClient } from "@dub/db";
import { startOfUtcDay, startOfUtcMonth } from "./time";

export interface ResendCounts {
  day: number | null;
  month: number | null;
}

async function countSentSince(mailDb: DbClient, sinceIso: string): Promise<number | null> {
  try {
    const row = await mailDb.first<{ c: number }>(
      "SELECT COUNT(*) AS c FROM mail_send_log WHERE status = 'sent' AND created_at >= ?",
      sinceIso,
    );
    const c = row?.c;
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  } catch {
    // table missing / query error -> unknown (null), never throw (graceful).
    return null;
  }
}

/** Sent-email counts for today and this month (UTC). null on read failure -> unknown. */
export async function countResendSends(mailDb: DbClient, now: Date): Promise<ResendCounts> {
  const [day, month] = await Promise.all([
    countSentSince(mailDb, startOfUtcDay(now).toISOString()),
    countSentSince(mailDb, startOfUtcMonth(now).toISOString()),
  ]);
  return { day, month };
}
