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
// Nothing here is public: every handler runs entry verify first (401 on missing/invalid
// session), and the admin pair additionally require the identity:admin permission (403).
import type { Context } from "hono";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { auth, identity } from "@dub/types";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices, type GatewayServices } from "../services";
import { authenticate, extractToken } from "../auth";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

interface PermissionsResponse {
  permissions: identity.PermissionKey[];
}

/** Fail-closed identity:admin gate. Fetches the actor's effective permissions from
 *  identity (internal endpoint) and throws 403 unless identity:admin is present. */
async function requireAdmin(svc: GatewayServices, ctx: RequestContext, actorId: string): Promise<void> {
  const perms = await svc.identity.get<PermissionsResponse>(
    ctx,
    `/internal/users/${encodeURIComponent(actorId)}/permissions`,
  );
  if (!perms.permissions.includes("identity:admin")) {
    throw errors.forbidden("identity:admin required");
  }
}

/** POST /api/v1/me/password — the logged-in user changes their OWN password (#5b).
 *  Session required at the edge; the raw session token is forwarded so auth-service
 *  re-derives the user and re-verifies the current password before rotating the hash. */
export async function selfPasswordHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  const authed = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
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

  const authed = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };
  await requireAdmin(svc, ctx, authed.userId);

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

  const authed = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };
  await requireAdmin(svc, ctx, authed.userId);

  const targetId = c.req.param("userId") ?? "";
  const res = await svc.authSvc.get<auth.AdminViewPasswordResponse>(
    ctx,
    `/internal/admin/users/${encodeURIComponent(targetId)}/password`,
  );
  return c.json(res);
}
