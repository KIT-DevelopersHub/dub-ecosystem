// Self profile composition handlers (アカウント設定 → 表示名/アバター). identity-roster's
// external PATCH /identity/users/:id requires identity:admin (it manages OTHER users),
// so a member editing their OWN profile can NOT ride the transparent proxy. Instead the
// gateway OWNS these two paths, authenticates the caller, and forwards to identity as a
// genuine service-to-service call scoped to the caller's OWN userId (no client-supplied
// target, no admin gate — the write can only touch the session user's display_name /
// avatar_url, so it can never escalate):
//
//   GET  /api/v1/me/profile   read self display name + avatar   (session required)
//   POST /api/v1/me/profile   edit self display name + avatar   (session required)
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { gateway, identity } from "@dub/types";
import type { RequestContext } from "@dub/http";
import { createServices } from "../services";
import { authenticate } from "../auth";
import { getRequestId } from "../context";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

/** GET /api/v1/me/profile — the signed-in user reads their OWN display name + avatar. */
export async function getSelfProfileHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };
  // internal S2S read of the caller's own identity master (same route /me composes).
  const user = await svc.identity.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(auth.userId)}`);
  const body: gateway.MeProfileResponse = { displayName: user.displayName, avatarUrl: user.avatarUrl };
  return c.json(body);
}

/** POST /api/v1/me/profile — the signed-in user updates their OWN display name / avatar.
 *  Forwards to identity's internal self-profile route scoped to the caller's userId. */
export async function updateSelfProfileHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };

  const input = await c.req
    .json<gateway.MeProfileUpdateRequest>()
    .catch(() => ({}) as gateway.MeProfileUpdateRequest);
  const patch: gateway.MeProfileUpdateRequest = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  // `avatarUrl: null` is a meaningful clear — forward it when the key is present.
  if ("avatarUrl" in input) patch.avatarUrl = input.avatarUrl ?? null;

  const user = await svc.identity.post<identity.IdentityUser, gateway.MeProfileUpdateRequest>(
    ctx,
    `/internal/users/${encodeURIComponent(auth.userId)}/profile`,
    patch,
  );
  const body: gateway.MeProfileResponse = { displayName: user.displayName, avatarUrl: user.avatarUrl };
  return c.json(body);
}
