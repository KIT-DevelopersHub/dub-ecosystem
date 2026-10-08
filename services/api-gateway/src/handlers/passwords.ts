// Password management composition handlers (themes #5a/#5b/#5c). auth-service exposes
// the credential surface, but the admin routes are internal-only (require x-dub-internal)
// and the `auth` segment is proxied PUBLIC with tokens stripped at the edge — so these
// endpoints can NOT ride the transparent proxy. Instead the gateway OWNS these three
// paths, authenticates the caller, enforces authorization, and forwards as a genuine
// service-to-service call (authSvc attaches x-dub-internal + x-dub-user-id):
//
//   POST /api/v1/me/password                      self change    (session required)
//   POST /api/v1/admin/users/:userId/password     set/re-issue   (identity:admin)
//   GET  /api/v1/admin/users/:userId/password     view           (identity:admin)
//
// Nothing here is public, and no handler below says so itself: POLICY_TABLE does. The gate
// has already authenticated the caller (AUTHENTICATED on the self route) and, for the admin
// pair, confirmed identity:admin — the inline requireAdmin() that used to live here is gone,
// so that 403 is now decided in exactly one place.
import type { Context } from "hono";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { auth } from "@dub/types";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices } from "../services";
import { extractToken } from "../auth";
import { authedActor } from "../policy";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

/** POST /api/v1/me/password — the logged-in user changes their OWN password (#5b).
 *  Session required at the edge; the raw session token is forwarded so auth-service
 *  re-derives the user and re-verifies the current password before rotating the hash. */
export async function selfPasswordHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  const authed = authedActor(c);
  const token = extractToken(c.req.raw.headers);
  if (!token) throw errors.unauthenticated("missing bearer/cookie token");

  const body = await c.req
    .json<Partial<auth.SelfPasswordChangeRequest>>()
    .catch(() => ({}) as Partial<auth.SelfPasswordChangeRequest>);
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };
  const res = await svc.authSvc.post<{ ok: true }, auth.SelfPasswordChangeRequest>(
    ctx,
    "/auth/password",
    { currentPassword: String(body.currentPassword ?? ""), newPassword: String(body.newPassword ?? "") },
    { headers: { authorization: `Bearer ${token}` } },
  );
  return c.json(res);
}

/** POST /api/v1/admin/users/:userId/password — admin sets or re-issues a user's initial
 *  password (#5a). Returns the generated password ONCE when none was supplied. */
export async function adminSetPasswordHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  // identity:admin was already enforced by the gate (POLICY_TABLE).
  const authed = authedActor(c);
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };

  const targetId = c.req.param("userId") ?? "";
  const body = await c.req.json<auth.AdminSetPasswordRequest>().catch(() => ({}) as auth.AdminSetPasswordRequest);
  const res = await svc.authSvc.post<auth.AdminSetPasswordResponse, auth.AdminSetPasswordRequest>(
    ctx,
    `/internal/admin/users/${encodeURIComponent(targetId)}/password`,
    body,
  );
  return c.json(res);
}

/** GET /api/v1/admin/users/:userId/password — admin views a user's current password
 *  (#5c). Sensitive read: auth-service decrypts on demand and audits every view. */
export async function adminViewPasswordHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  // identity:admin was already enforced by the gate (POLICY_TABLE).
  const authed = authedActor(c);
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };

  const targetId = c.req.param("userId") ?? "";
  const res = await svc.authSvc.get<auth.AdminViewPasswordResponse>(
    ctx,
    `/internal/admin/users/${encodeURIComponent(targetId)}/password`,
  );
  return c.json(res);
}
