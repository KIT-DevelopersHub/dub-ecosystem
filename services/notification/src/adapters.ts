// Channel adapters (design §2) + the delivery runner. Each adapter implements the
// ChannelAdapter I/F so mail/chat/push can be swapped in unchanged at the infra波.
// P0: in_app is fully implemented; email/chat/push perform real port calls when the
// port is wired (tests inject fakes) and return "skipped" when it is absent.
import type { DbClient } from "@dub/db";
import { publishAudit } from "@dub/events";
import { consoleSink } from "@dub/observability";
import type { RequestContext } from "@dub/http";
import type { Queue } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import type { auditLog } from "@dub/types";
import type { ChatPort, IdentityPort, MailPort, PushPort } from "./clients";
import { insertInbox, recordDelivery } from "./repo";
import { DEFAULT_MAILBOX, MAX_DELIVERY_ATTEMPTS, SERVICE_NAME } from "./config";
import type { ChannelAdapter, DeliveryJob, DeliveryResult, NotificationChannel } from "./types";
import { nowIso } from "@dub/db";

// ---- in_app ----
export function makeInAppAdapter(db: DbClient): ChannelAdapter {
  return {
    channel: "in_app",
    async deliver(job: DeliveryJob): Promise<DeliveryResult> {
      await insertInbox(db, job.notificationId, job.userId);
      return { status: "sent" };
    },
  };
}

// ---- email (mail-gateway POST /send) ----
export function makeEmailAdapter(deps: {
  mail?: MailPort;
  identity: IdentityPort;
  ctx: RequestContext;
}): ChannelAdapter {
  return {
    channel: "email",
    async deliver(job: DeliveryJob): Promise<DeliveryResult> {
      if (!deps.mail) return { status: "skipped", detail: "channel_not_wired" };
      const email = await deps.identity.getEmail(job.userId, deps.ctx);
      if (!email) return { status: "skipped", detail: "no_email_on_file" };
      const idempotencyKey = `${job.notificationId}:${job.userId}:email`;
      await deps.mail.send(
        {
          to: [{ email }],
          subject: job.title,
          textBody: job.body ?? job.title,
        },
        idempotencyKey,
        deps.ctx,
      );
      return { status: "sent", detail: `mailbox=${DEFAULT_MAILBOX}` };
    },
  };
}

// ---- chat (chat-service POST /internal/system-messages) ----
export function makeChatAdapter(deps: { chat?: ChatPort; ctx: RequestContext }): ChannelAdapter {
  return {
    channel: "chat",
    async deliver(job: DeliveryJob): Promise<DeliveryResult> {
      if (!deps.chat) return { status: "skipped", detail: "channel_not_wired" };
      await deps.chat.postSystemMessage({ userId: job.userId, title: job.title, body: job.body }, deps.ctx);
      return { status: "sent" };
    },
  };
}

// ---- push (mobile-bff POST /internal/push/dispatch) ----
export function makePushAdapter(deps: { push?: PushPort; ctx: RequestContext }): ChannelAdapter {
  return {
    channel: "push",
    async deliver(job: DeliveryJob): Promise<DeliveryResult> {
      if (!deps.push) return { status: "skipped", detail: "channel_not_wired" };
      await deps.push.dispatch(
        { userId: job.userId, type: job.type, title: job.title, body: job.body },
        deps.ctx,
      );
      return { status: "sent" };
    },
  };
}

export type AdapterRegistry = Record<NotificationChannel, ChannelAdapter>;

export interface DeliveryRunnerDeps {
  db: DbClient;
  adapters: AdapterRegistry;
  // null when neither a paid Queue nor the free-tier @dub/freeq outbox is bound; publish
  // is then skipped (a safe no-op, never a throw). See deps.ts / outbox.ts.
  auditQueue: { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> } | null;
  orgId: string;
  maxAttempts?: number;
}

/**
 * Run one delivery job through its channel adapter with bounded retries. A "skipped"
 * result is recorded with attempts=0 and never retried. A thrown adapter error is
 * retried up to maxAttempts; on final failure the delivery is marked "failed" and a
 * single delivery-failed audit record is emitted via publishAudit (design test #13).
 */
export async function runDelivery(deps: DeliveryRunnerDeps, job: DeliveryJob): Promise<DeliveryResult> {
  const adapter = deps.adapters[job.channel];
  const maxAttempts = deps.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;

  let attempts = 0;
  let lastError: string | null = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const result = await adapter.deliver(job);
      if (result.status === "skipped") {
        await recordDelivery(deps.db, job.notificationId, job.userId, job.channel, "skipped", 0, result.detail ?? null);
        return result;
      }
      await recordDelivery(deps.db, job.notificationId, job.userId, job.channel, "sent", attempts, null);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // exhausted → failed + audit (delivery.delivery_failed event was retired; audit only)
  await recordDelivery(deps.db, job.notificationId, job.userId, job.channel, "failed", attempts, lastError);
  const audit: auditLog.AuditRecordInput = {
    action: "notif.delivery.failed",
    actorId: null,
    orgId: deps.orgId,
    result: "failure",
    resourceType: "notification",
    resourceId: job.notificationId,
    details: { channel: job.channel, userId: job.userId, attempts, lastError },
    requestId: job.requestId,
    occurredAt: nowIso(),
  };
  // On the paid deploy deps.auditQueue is the real Queue; on the free tier it is the
  // @dub/freeq D1 outbox shim (durable, drained to audit-log). null only when neither is
  // bound — then there is no audit sink to publish to (safe no-op).
  if (deps.auditQueue) {
    try {
      await publishAudit(deps.auditQueue, audit);
    } catch (auditErr) {
      consoleSink({
        level: "error",
        message: "failed to publish delivery-failed audit",
        service: SERVICE_NAME,
        requestId: job.requestId,
        fields: { error: auditErr instanceof Error ? auditErr.message : String(auditErr) },
      });
    }
  }
  return { status: "failed", detail: lastError ?? undefined };
}

// A skipped-because-off delivery (preferences resolved to disabled). Recorded so the
// deliveries table is a complete audit of what happened to each (user,channel).
export async function recordSkipped(
  db: DbClient,
  job: Pick<DeliveryJob, "notificationId" | "userId" | "channel">,
  detail: string,
): Promise<void> {
  await recordDelivery(db, job.notificationId, job.userId, job.channel, "skipped", 0, detail);
}
