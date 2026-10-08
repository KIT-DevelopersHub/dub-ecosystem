// GET /api/v1/me — self info + effective (org-wide) permissions. Composition only:
// identity master + internal permissions. No cache in P0. AUTHENTICATED in POLICY_TABLE:
// the gate verified the session, so the id used below is always the caller's own (the
// permission list in the response is DATA about the caller, not an authorization check).
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { identity, gateway } from "@dub/types";
import { policy } from "@dub/types";
import type { RequestContext } from "@dub/http";
import { createServices } from "../services";
import { authedActor } from "../policy";
import { getRequestId } from "../context";

interface PermissionsResponse {
  permissions: identity.PermissionKey[];
}

export async function meHandler(c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  const auth = authedActor(c);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };

  // parallel: identity master + effective permissions (internal endpoint -> needs x-dub-internal)
  const [user, perms] = await Promise.all([
    svc.identity.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(auth.userId)}`),
    svc.identity.get<PermissionsResponse>(ctx, `/internal/users/${encodeURIComponent(auth.userId)}/permissions`),
  ]);

  const body: gateway.MeResponse = {
    user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, email: user.email },
    orgId: user.orgId,
    permissions: perms.permissions,
    sessionExpiresAt: auth.session ? auth.session.sessionExpiresAt : 0,
    // Per-app 無効/閲覧/編集 for every registered app, derived from the effective permission
    // set by the policy layer. Pure projection (no extra upstream call) — the shell reads it
    // to decide which write affordances are live instead of each feature re-deriving it.
    appAccess: policy.appAccessMap(perms.permissions),
  };
  return c.json(body);
}
