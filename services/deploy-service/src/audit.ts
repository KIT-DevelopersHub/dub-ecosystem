// Write-ahead audit (theme#13). Two stages:
//   intent  -> synchronous SB POST /internal/log, FAIL-CLOSE (blocks the CF call)
//   result  -> Queue publishAudit (best-effort, never rolls back a done CF change)
// action vocabulary is the frozen SYNC_AUDIT_ACTIONS ("infra.deploy.executed" /
// "infra.dns.changed"), NOT the older "deploy.execute" wording in the P0a draft.
import { createServiceClient } from "@dub/http";
import type { RequestContext } from "@dub/http";
import { DubError, CommonErrorCodes, isDubError } from "@dub/errors";
import { publishAudit } from "@dub/events";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import { newId } from "@dub/db";
import { common } from "@dub/types";
import type { auditLog } from "@dub/types";
import type { Fetcher, Queue } from "@cloudflare/workers-types";

export type SyncAuditAction = "infra.deploy.executed" | "infra.dns.changed";

export interface IntentInput {
  action: SyncAuditAction;
  actorId: string | null;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
}

export interface ResultInput {
  action: SyncAuditAction;
  actorId: string | null;
  result: "success" | "failure";
  resourceType: string;
  resourceId: string;
  intentId: string;
  details?: Record<string, unknown>;
}

export interface AuditGateway {
  /** Record intent BEFORE the strong-privilege call. Returns the intent record id.
   *  Any failure throws UPSTREAM_UNAVAILABLE (502) — the caller MUST NOT proceed. */
  recordIntent(ctx: RequestContext, input: IntentInput): Promise<string>;
  /** Record the outcome after the call (Queue). Best-effort. */
  recordResult(ctx: RequestContext, input: ResultInput): Promise<void>;
}

const INTENT_TIMEOUT_MS = 2000; // design §6 SLO
const INTENT_MAX_ATTEMPTS = 2; // 1 try + 1 retry

export function createAuditGateway(deps: {
  auditBinding: Fetcher;
  auditQueue: Queue<AuditRecordEnvelopeV1>;
  serviceName: string;
}): AuditGateway {
  const client = createServiceClient(deps.auditBinding, {
    service: "audit-log",
    caller: deps.serviceName,
    timeoutMs: INTENT_TIMEOUT_MS,
  });

  return {
    async recordIntent(ctx, input) {
      const record: auditLog.AuditRecordInput = {
        action: input.action,
        actorId: input.actorId,
        orgId: common.DUB_DEFAULT_ORG_ID,
        result: "intent",
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        details: input.details,
        requestId: ctx.requestId,
        occurredAt: new Date().toISOString(),
      };
      // ULID idempotency key enables @dub/http retry (INSERT OR IGNORE on the audit side).
      const idem = newId("aud");
      try {
        const res = await client.post<auditLog.AuditLogWriteResponse, auditLog.AuditRecordInput>(
          ctx,
          "/internal/log",
          record,
          { idempotencyKey: idem, retry: { maxAttempts: INTENT_MAX_ATTEMPTS } },
        );
        if (!res || !res.id) {
          throw new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "audit-log returned no id", {
            status: 502,
            service: "audit-log",
          });
        }
        return res.id;
      } catch (err) {
        // fail-close: normalize every failure to UPSTREAM_UNAVAILABLE so the route
        // rejects with 502 and never performs the strong-privilege operation.
        if (isDubError(err) && err.code === CommonErrorCodes.UPSTREAM_UNAVAILABLE) throw err;
        throw new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "audit-log intent write failed (fail-close)", {
          status: 502,
          service: "audit-log",
          cause: err,
        });
      }
    },

    async recordResult(ctx, input) {
      const record: auditLog.AuditRecordInput = {
        action: input.action,
        actorId: input.actorId,
        orgId: common.DUB_DEFAULT_ORG_ID,
        result: input.result,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        details: { ...(input.details ?? {}), intent_id: input.intentId },
        requestId: ctx.requestId,
        occurredAt: new Date().toISOString(),
      };
      await publishAudit({ AUDIT_QUEUE: deps.auditQueue }, record);
    },
  };
}
