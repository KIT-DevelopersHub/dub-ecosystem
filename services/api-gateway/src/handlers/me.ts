// GET /api/v1/me — self info + effective (org-wide) permissions. Composition only:
// entry verify -> identity master + internal permissions. No cache in P0.
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { identity, gateway } from "@dub/types";
import type { RequestContext } from "@dub/http";
import { createServices } from "../services";
import { authenticate } from "../auth";
import { getRequestId } from "../context";

interface PermissionsResponse {
  permissions: identity.PermissionKey[];
}

export async function meHandler(c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };

  // parallel: identity master + effective permissions (internal endpoint -> needs x-dub-internal)
  const [user, perms] = await Promise.all([
    svc.identity.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(auth.userId)}`),
    svc.identity.get<PermissionsResponse>(ctx, `/internal/users/${encodeURIComponent(auth.userId)}/permissions`),
  ]);

  const body: gateway.MeResponse = {
    user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl },
    orgId: user.orgId,
    permissions: perms.permissions,
    sessionExpiresAt: auth.session ? auth.session.sessionExpiresAt : 0,
  };
  return c.json(body);
}
