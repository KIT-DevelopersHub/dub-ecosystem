// Production wiring of the Deps side-effect sinks over Cloudflare bindings.
// Degraded fallbacks keep the P0 unit deployable before audit-log / auth-service
// bindings exist; the fail-close contract still holds once they are wired.
import { createServiceClient, type RequestContext } from "@dub/http";
import { CONSUMER_QUEUE_BINDINGS, createEvent, publishAudit, publishEvent, type AuditRecordEnvelopeV1, type DubEventEnvelope } from "@dub/events";
import { errors } from "@dub/errors";
import type { auditLog } from "@dub/types";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import { identity, type meeting } from "@dub/types";
import type { AuditSink, DomainEventSink, RequestCtx, RoleMembershipOutcome, RoleMembershipSink, SessionRevoker } from "./deps";
import type { Env } from "./env";
import { AUDIT_TOPIC, outboxQueue } from "./outbox";

const SERVICE = "identity-roster";

export function createAuditSink(env: Env): AuditSink {
  const logClient = env.SVC_AUDIT_LOG
    ? createServiceClient(env.SVC_AUDIT_LOG, { service: "audit-log", caller: SERVICE, timeoutMs: 2000, retry: { maxAttempts: 2 } })
    : null;
  // Prefer the real (paid) Queue when present; otherwise fall back to the free-tier
  // @dub/freeq D1 outbox shim so best-effort audit records are durably persisted (drained
  // to audit-log by the Cron in index.ts), never silently dropped. Only when BOTH are
  // absent (a bare unit deploy with no OUTBOX_DB) does publish stay a no-op.
  const queue = env.AUDIT_QUEUE ?? (env.OUTBOX_DB ? outboxQueue<AuditRecordEnvelopeV1>(env.OUTBOX_DB, AUDIT_TOPIC) : null);

  return {
    async logSync(input: auditLog.AuditRecordInput): Promise<void> {
      if (!logClient) return; // degraded (pre-integration): sync audit is a no-op
      const ctx: RequestContext = { requestId: input.requestId, ...(input.actorId ? { userId: input.actorId } : {}) };
      try {
        await logClient.post<auditLog.AuditLogWriteResponse>(ctx, "/internal/log", input, { idempotencyKey: `${input.action}:${input.requestId}:${input.resourceId ?? ""}` });
      } catch (cause) {
        throw errors.upstreamUnavailable("audit-log", cause); // fail-close: caller aborts the mutation
      }
    },
    async publish(input: auditLog.AuditRecordInput): Promise<void> {
      if (!queue) return; // degraded: best-effort audit dropped
      try {
        await publishAudit({ AUDIT_QUEUE: queue }, input);
      } catch {
        // best-effort: never surface into the business flow
      }
    },
  };
}

export function createSessionRevoker(env: Env): SessionRevoker {
  const client = env.SVC_AUTH
    ? createServiceClient(env.SVC_AUTH, { service: "auth-service", caller: SERVICE, timeoutMs: 2000, retry: { maxAttempts: 2 } })
    : null;
  return {
    async revokeUser(userId: string, ctx: RequestCtx): Promise<void> {
      if (!client) return; // degraded: no auth binding yet
      const rc: RequestContext = { requestId: ctx.requestId, ...(ctx.actorId ? { userId: ctx.actorId } : {}) };
      try {
        await client.post(rc, "/internal/revoke-user", { userId }, { idempotencyKey: `revoke:${userId}:${ctx.requestId}` });
      } catch (cause) {
        throw errors.upstreamUnavailable("auth-service", cause); // fail-close: suspend aborts
      }
    },
  };
}

/** identity waits this long for drive-share inside the admin's request (api-gateway cuts at 15 s). */
export const ROLE_MEMBERSHIP_TIMEOUT_MS = 10_000;

/**
 * Role membership changes -> drive-share-service POST /internal/role-membership, synchronously: the
 * caller awaits it, so the role's Drive共有 grants and ミーティング invitations reach (or leave) the user
 * as part of the change. No queue. Without SVC_DRIVE_SHARE (tests, bare deploys) nothing is sent.
 */
export function createRoleMembershipSink(
  env: Env,
  deps: { now: () => string; newId: (prefix: string) => string; timeoutMs?: number },
): RoleMembershipSink {
  const timeoutMs = deps.timeoutMs ?? ROLE_MEMBERSHIP_TIMEOUT_MS;
  return {
    async changed(notice): Promise<RoleMembershipOutcome> {
      const svc = env.SVC_DRIVE_SHARE;
      if (!svc || notice.roleIds.length === 0) return { ok: true };
      const msg: identity.RoleMembershipChangedV1 = {
        type: "identity.role_membership.changed",
        version: 1,
        id: deps.newId("rm"),
        occurredAt: deps.now(),
        orgId: notice.orgId,
        userId: notice.userId,
        change: notice.change,
        roleIds: [...new Set(notice.roleIds)],
        reason: notice.reason,
      };
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await svc.fetch(`https://drive-share${identity.ROLE_MEMBERSHIP_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", [HDR_INTERNAL]: INTERNAL_HEADER_VALUE },
          body: JSON.stringify(msg),
          signal: abort.signal,
        });
        if (!res.ok) return fail(msg, `Drive共有・ミーティングへの反映に失敗しました（HTTP ${res.status}）。`);
        const body = (await res.json().catch(() => null)) as meeting.RoleMembershipFollowResponse | null;
        if (body && body.complete === false) return fail(msg, (body.problems ?? []).join(" ") || "Drive共有・ミーティングへの反映が一部終わりませんでした。");
        return { ok: true };
      } catch (err) {
        const timedOut = abort.signal.aborted;
        return fail(msg, timedOut ? `Drive共有・ミーティングへの反映が ${Math.round(timeoutMs / 1000)} 秒以内に終わりませんでした。` : `Drive共有・ミーティングへ届きませんでした（${err instanceof Error ? err.message : String(err)}）。`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function fail(msg: identity.RoleMembershipChangedV1, message: string): RoleMembershipOutcome {
  console.warn(JSON.stringify({ service: SERVICE, event: "role_membership_propagation_failed", messageId: msg.id, userId: msg.userId, change: msg.change, roleIds: msg.roleIds, reason: msg.reason, message }));
  return { ok: false, message };
}

/**
 * Domain events (#850: identity.user.activated -> chat). Paid deploy: the EVT_* Queue binding;
 * free tier: the @dub/freeq outbox under `evt.<consumer>` (freeq-drain delivers evt.chat to
 * chat-service). Best-effort: a failure is logged, never thrown — activation must not roll
 * back because a side effect could not be queued (the admin bulk action covers misses).
 */
export function createDomainEventSink(env: Env): DomainEventSink | undefined {
  const db = env.OUTBOX_DB;
  const queues: Record<string, unknown> = {};
  for (const [consumer, binding] of Object.entries(CONSUMER_QUEUE_BINDINGS)) {
    const real = (env as unknown as Record<string, unknown>)[binding];
    if (real) queues[binding] = real;
    else if (db) queues[binding] = outboxQueue<DubEventEnvelope>(db, `evt.${consumer}`);
  }
  if (Object.keys(queues).length === 0) return undefined;
  return {
    async userActivated(input, ctx): Promise<void> {
      try {
        const event = createEvent("identity.user.activated", input, { requestId: ctx.requestId, actorId: ctx.actorId });
        await publishEvent(queues as Parameters<typeof publishEvent>[0], event);
      } catch (err) {
        console.warn(JSON.stringify({ level: "warn", service: SERVICE, message: "identity.user.activated publish failed", userId: input.userId, err: String(err) }));
      }
    },
  };
}
