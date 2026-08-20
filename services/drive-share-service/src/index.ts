// Worker entrypoint / composition root. buildApp wires bindings -> deps -> Hono app.
// The ONE auth seam lives here: useMockClient(env) decides whether the REAL Google
// Drive v3 client (real OAuth refresh-token provider, refresh token from Workers
// Secrets, access token cached in-isolate) or the in-memory MOCK client is used. When
// the three GOOGLE_HACKIT_OAUTH_* secrets are absent (or DRIVESHARE_MOCK=1) the mock
// runs, so this Worker builds, deploys, and is E2E-testable at $0 before any real
// refresh token exists. Dropping in the real token is exactly this one branch — no
// other code changes. Authz is the identity-roster /authz/check (drive:read / write).
import type { ExecutionContext, Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, newRequestId } from "@dub/http";
import { createDbClient, newId, nowIso } from "@dub/db";
import { common, type identity } from "@dub/types";
import { createApp } from "./app";
import { createDriveShareService } from "./service";
import { createRoleGrantsService } from "./role-grants-service";
import { createD1RoleGrantStore } from "./role-grants-store";
import { createIdentityRoleMembership } from "./role-membership";
import { createMockDriveShareClient } from "./mock-client";
import { createGoogleDriveShareClient } from "./google/client";
import { createTokenProvider } from "./google/token";
import type { DriveShareClient } from "./drive-client";
import type { PermissionChecker, DrivePermission } from "./permissions";
import { parseConfig, useMockClient, type Env } from "./env";

/**
 * identity /authz/check checker. drive:read / drive:write are not yet in the frozen
 * PermissionKey union so the key is cast at the wire boundary; identity resolves it as
 * a plain string. Swap the cast for a typed key when the catalog adds the two entries
 * (no behavioural change) — same posture as drive-proxy.
 */
function createIdentityAuthz(binding: Fetcher): PermissionChecker {
  const client = createServiceClient(binding, { service: "identity-roster", caller: "drive-share-service" });
  return {
    async check(userId: string, orgId: string, permission: DrivePermission): Promise<boolean> {
      const req: identity.AuthzCheckRequest = {
        subjectUserId: userId,
        orgId,
        checks: [{ permission: permission as unknown as identity.PermissionKey }],
      };
      const res = await client.post<identity.AuthzCheckResponse>({ requestId: newRequestId() }, "/authz/check", req);
      return res.decisions[0]?.allowed ?? false;
    },
  };
}

/** Pick the Drive client: mock until the Hackit OAuth secrets are bound, real after. */
function buildDriveClient(env: Env): DriveShareClient {
  if (useMockClient(env)) return createMockDriveShareClient();
  const token = createTokenProvider({
    credentials: {
      clientId: env.GOOGLE_HACKIT_OAUTH_CLIENT_ID!,
      clientSecret: env.GOOGLE_HACKIT_OAUTH_CLIENT_SECRET!,
      refreshToken: env.GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN!,
    },
  });
  return createGoogleDriveShareClient({ token });
}

/** Per-request request context (from the trusted x-dub-* headers). The role-membership
 *  client needs the acting user id so identity can resolve /identity/roles (identity:read),
 *  so the app is built per request — mirrors member-service's buildDeps(env, requestId). */
interface ReqCtx {
  requestId: string;
  userId?: string;
}

function buildApp(env: Env, reqCtx: ReqCtx): ReturnType<typeof createApp> {
  const client = buildDriveClient(env);
  const service = createDriveShareService({ client, config: parseConfig(env) });
  const authz = createIdentityAuthz(env.SVC_IDENTITY);
  const orgId = common.DUB_DEFAULT_ORG_ID;

  const store = createD1RoleGrantStore(createDbClient(env.DB, { namespace: "driveshare", requestId: reqCtx.requestId }));
  const roster = createIdentityRoleMembership(env.SVC_IDENTITY, {
    requestId: reqCtx.requestId,
    ...(reqCtx.userId ? { userId: reqCtx.userId } : {}),
  });
  const roleGrants = createRoleGrantsService({
    drive: client,
    roster,
    store,
    orgId,
    now: nowIso,
    newId: () => newId("dsg"),
  });

  return createApp({ service, roleGrants, authz });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? newRequestId();
    const userId = request.headers.get("x-dub-user-id") ?? undefined;
    return buildApp(env, { requestId, ...(userId ? { userId } : {}) }).fetch(request, env, ctx);
  },
};
