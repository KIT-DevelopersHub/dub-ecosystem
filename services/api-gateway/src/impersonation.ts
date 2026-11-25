// Admin impersonation (代理表示) at the edge.
//
// While an admin views the app AS a member, auth-service verifies the session as the MEMBER
// (userId = subject) and reports the real admin in `impersonation`. Downstream services then
// authorize with the member's own permissions automatically — that is the point: the admin
// sees exactly what the member sees. Two things are added here on top:
//
// 1. A DENY LIST of high-risk actions that are never performed as someone else, even when
//    the member could perform them: credential / email / role & permission changes, starting
//    another impersonation, and outbound mail (send / schedule / forwarding). Drafts and all
//    reads stay allowed. Checked for gateway-owned routes (middleware, after the gate) and for
//    proxied routes (gateway-route.ts, right after entry verify). The auth segment is not
//    verified at the edge, so auth-service blocks its own credential routes itself.
//
// 2. An AUDIT TAG on every mutating request made during impersonation (actor = the real
//    admin, subject + method + path + status in details), and on every denied attempt. Sent
//    to audit-log's open-vocabulary landing (/internal/audit-async) via waitUntil — best
//    effort, never on the request's critical path. Start/stop are audited durably by
//    auth-service's outbox.
//
// Paths below are EXTERNAL (as the browser calls them, under /api/v1).
import type { Context, MiddlewareHandler } from "hono";
import type { auth } from "@dub/types";
import { auth as authRules, common } from "@dub/types";
import { createServiceClient } from "@dub/http";
import type { GatewayEnv } from "./env";
import type { GatewayVariables } from "./context";
import { getRequestId, gatewayError } from "./context";

export const IMPERSONATION_ACTION_BLOCKED = "IMPERSONATION_ACTION_BLOCKED"; // 403

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The deny list itself is SoT in @dub/types (auth.IMPERSONATION_BLOCK_RULES) so the demo
// transport and any UI hint read the same rules the edge enforces.
export const impersonationBlockReason = authRules.impersonationBlockReason;

export interface ImpersonationAuditRecord {
  action: "auth.impersonation.request" | "auth.impersonation.blocked";
  actorId: string;
  subjectId: string;
  result: "success" | "failure" | "denied";
  requestId: string;
  details: Record<string, unknown>;
}

export type ImpersonationAuditSink = (c: Ctx, rec: ImpersonationAuditRecord) => Promise<void>;

/** Production sink: audit-log /internal/audit-async with the canonical envelope. */
export const auditLogSink: ImpersonationAuditSink = async (c, rec) => {
  const client = createServiceClient(c.env.SVC_AUDIT_LOG, { service: "audit-log", caller: "api-gateway" });
  const id = crypto.randomUUID();
  const envelope = {
    type: "audit.record",
    version: 1,
    id,
    payload: {
      action: rec.action,
      actorId: rec.actorId,
      orgId: common.DUB_DEFAULT_ORG_ID,
      result: rec.result,
      resourceType: "user",
      resourceId: rec.subjectId,
      details: { subjectId: rec.subjectId, ...rec.details },
      requestId: rec.requestId,
      occurredAt: new Date().toISOString(),
    },
  };
  await client.post(
    { requestId: rec.requestId, userId: rec.actorId, caller: "api-gateway" },
    "/internal/audit-async",
    envelope,
  );
};

/** Fire-and-forget: never fail (or slow) the member-view request because audit hiccuped. */
function dispatch(c: Ctx, sink: ImpersonationAuditSink, rec: ImpersonationAuditRecord): void {
  const p = sink(c, rec).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // no ExecutionContext (unit tests): the promise still runs
  }
}

/**
 * Throw 403 (and audit) when the current request is on the deny list while impersonating.
 * No-op when the caller is not impersonating or not yet authenticated.
 */
export function enforceImpersonationPolicy(c: Ctx, sink: ImpersonationAuditSink): void {
  const imp = c.get("authed")?.impersonation;
  if (!imp) return;
  const path = new URL(c.req.url).pathname;
  const reason = impersonationBlockReason(c.req.method, path);
  if (!reason) return;
  c.set("impersonationBlocked", true);
  dispatch(c, sink, {
    action: "auth.impersonation.blocked",
    actorId: imp.actorId,
    subjectId: imp.subjectId,
    result: "denied",
    requestId: getRequestId(c),
    details: { method: c.req.method.toUpperCase(), path, reason },
  });
  throw gatewayError(
    IMPERSONATION_ACTION_BLOCKED,
    "This action is not allowed while viewing as another member",
    403,
    { reason },
  );
}

/**
 * Mounted right after the policy gate. Pre: deny-list check for gateway-owned routes (the
 * gate already authenticated them). Post: tag every mutating request made during
 * impersonation — by then the proxy path has authenticated too, so both are covered.
 */
export function impersonationGuard(sink: ImpersonationAuditSink): MiddlewareHandler<{ Bindings: GatewayEnv; Variables: GatewayVariables }> {
  return async (c, next) => {
    enforceImpersonationPolicy(c, sink);
    await next();
    const imp: auth.ImpersonationInfo | null | undefined = c.get("authed")?.impersonation;
    if (!imp || READ_METHODS.has(c.req.method.toUpperCase())) return;
    if (c.get("impersonationBlocked")) return; // already audited as blocked
    dispatch(c, sink, {
      action: "auth.impersonation.request",
      actorId: imp.actorId,
      subjectId: imp.subjectId,
      result: c.res.status < 400 ? "success" : "failure",
      requestId: getRequestId(c),
      details: { method: c.req.method.toUpperCase(), path: new URL(c.req.url).pathname, status: c.res.status },
    });
  };
}
