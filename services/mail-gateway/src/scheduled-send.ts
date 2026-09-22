// Scheduled-send (予約送信 / 予約投稿) drain. Runs from the mail-gateway Cron Trigger
// (see index.ts scheduled()). Claims due rows (status='scheduled' AND scheduled_at <= now)
// and hands each to the SAME send core as an immediate send, so 二重送信ゼロ, the Sent
// folder and the archive-CC all hold. $0: no paid Queue — the schedule row IS the durable
// timer, and the existing cron is the ticker (no new cron trigger is added).
//
// Idempotency: each delivery uses the idempotency key `sched:<rowId>`, so a drain that
// crashes AFTER the provider send but BEFORE the status write re-attempts on the next tick
// and the send-core dedups against the same send-log row (no double email). Only after a
// successful send do we flip the schedule row to 'sent'.
import { newRequestId } from "@dub/http";
import type { RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import type { mail } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { buildDb, buildSendDeps } from "./deps";
import { resolveReplyFromAddress, resolveUserFromAddress } from "./from";
import {
  claimDueScheduled,
  markScheduledAttemptFailed,
  markScheduledSent,
  type ScheduledRow,
} from "./repo";
import { sendMail } from "./send";
import type { Env } from "./env";

// How many due schedules a single drain pass sends (bounded work per tick).
export const SCHEDULED_DRAIN_BATCH = 25;
// Drain attempts before a due schedule goes terminal 'failed' (matches the send-log's own
// bounded retry posture; a transient provider outage is retried across several ticks).
export const SCHEDULED_MAX_ATTEMPTS = 6;

export interface ScheduledDrainResult {
  claimed: number;
  sent: number;
  failed: number; // terminal failures this pass
  retried: number; // kept 'scheduled' for a later tick
}

/** Rebuild the SendMailRequest a scheduled row stored. */
function toSendRequest(row: ScheduledRow): mail.SendMailRequest {
  const to = JSON.parse(row.to_json) as mail.MailAddress[];
  const req: mail.SendMailRequest = { to, subject: row.subject, textBody: row.text_body };
  const cc = row.cc_json ? (JSON.parse(row.cc_json) as mail.MailAddress[]) : [];
  if (cc.length > 0) req.cc = cc;
  if (row.html_body) req.htmlBody = row.html_body;
  if (row.in_reply_to) req.inReplyTo = row.in_reply_to;
  return req;
}

/** One drain pass over the due scheduled sends. Never throws — a per-row failure is
 *  captured on the row (retried or terminal) so one bad schedule can't stall the rest. */
export async function runScheduledSendDrain(env: Env, now: number = Date.now()): Promise<ScheduledDrainResult> {
  const ctx: RequestContext = { requestId: newRequestId(), caller: SERVICE_NAME };
  const db = buildDb(env, ctx.requestId);
  const due = await claimDueScheduled(db, new Date(now).toISOString(), SCHEDULED_DRAIN_BATCH);
  const out: ScheduledDrainResult = { claimed: due.length, sent: 0, failed: 0, retried: 0 };

  for (const row of due) {
    const attempts = row.attempts + 1;
    try {
      const req = toSendRequest(row);
      // From: a stored envelope wins; else resolve the composer's own address (or the
      // shared mailbox for a reply) exactly like the interactive /outbox lane.
      const fromAddress =
        row.from_address ??
        (row.in_reply_to
          ? await resolveReplyFromAddress(env, ctx, db, row.in_reply_to, row.owner_user_id)
          : await resolveUserFromAddress(env, ctx, row.owner_user_id));
      const deps = buildSendDeps(env, ctx, undefined, fromAddress, row.owner_user_id);
      const { response } = await sendMail(deps, req, `sched:${row.id}`, row.owner_user_id ?? SERVICE_NAME);
      await markScheduledSent(db, row.id, response.messageId, attempts);
      out.sent++;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "MAIL_PROVIDER_UNAVAILABLE";
      await markScheduledAttemptFailed(db, row.id, String(code), attempts, SCHEDULED_MAX_ATTEMPTS);
      if (attempts >= SCHEDULED_MAX_ATTEMPTS) out.failed++;
      else out.retried++;
      consoleSink({
        level: "warn",
        message: "mail-gateway: scheduled send attempt failed",
        service: SERVICE_NAME,
        requestId: ctx.requestId,
        fields: { id: row.id, attempts, code: String(code) },
      });
    }
  }
  if (due.length > 0) {
    consoleSink({ level: "info", message: "mail-gateway scheduled-send drain finished", service: SERVICE_NAME, fields: { ...out } });
  }
  return out;
}
