// Worker entrypoint / composition root. buildApp wires bindings -> deps -> Hono app.
// The ONE auth seam lives here: resolveDriveCredentials picks the refresh token — the
// account an admin connected from ロール管理 (D1, AES-GCM sealed) first, else the
// GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN secret — and buildDriveClient wires the REAL Google
// Drive v3 client over it. With neither (or DRIVESHARE_MOCK=1) the in-memory MOCK client
// runs, so this Worker builds, deploys, and is E2E-testable at $0 without any token. Authz is POLICY_TABLE (src/policy-table.ts) enforced by @dub/policy-gate,
// whose decisions come from identity-roster POST /authz/check (TTL-cached per isolate — see
// sharedAuthzGranter below).
import type { ExecutionContext } from "@cloudflare/workers-types";
import { newRequestId } from "@dub/http";
import { sharedAuthzGranter } from "@dub/policy-gate";
import { createDbClient, newId, nowIso } from "@dub/db";
import { common } from "@dub/types";
import { createApp } from "./app";
import { createDriveShareService } from "./service";
import { createRoleGrantsService } from "./role-grants-service";
import { createD1RoleGrantStore } from "./role-grants-store";
import { createIdentityRoleMembership } from "./role-membership";
import { createMockDriveShareClient } from "./mock-client";
import { createGoogleDriveShareClient } from "./google/client";
import { createTokenProvider } from "./google/token";
import type { DriveShareClient } from "./drive-client";
import { createD1GoogleAccountStore } from "./google-account-store";
import { createGoogleAccountService, resolveDriveCredentials, type ResolvedCredentials } from "./google-account";
import { importTokenKey } from "./google/crypto";
import { mockForced, parseConfig, type Env } from "./env";

/** Pick the Drive client: real when an account is available (connected from ロール管理, or
 *  the secret token), mock otherwise or when DRIVESHARE_MOCK forces it. */
function buildDriveClient(env: Env, resolved: ResolvedCredentials): DriveShareClient {
  if (mockForced(env) || resolved.source === "none") return createMockDriveShareClient();
  return createGoogleDriveShareClient({ token: createTokenProvider({ credentials: resolved.credentials }) });
}

/** Defers the account lookup (a D1 read) to the first Drive call, so health probes and
 *  the account routes themselves never depend on it. */
function lazyDriveClient(load: () => Promise<DriveShareClient>): DriveShareClient {
  let client: Promise<DriveShareClient> | null = null;
  const get = () => (client ??= load());
  return {
    listFiles: async (p) => (await get()).listFiles(p),
    listPermissions: async (fileId) => (await get()).listPermissions(fileId),
    createPermission: async (fileId, p) => (await get()).createPermission(fileId, p),
    updatePermission: async (fileId, permId, role) => (await get()).updatePermission(fileId, permId, role),
    deletePermission: async (fileId, permId) => (await get()).deletePermission(fileId, permId),
  };
}

/** Per-request request context (from the trusted x-dub-* headers). The role-membership
 *  client needs the acting user id so identity can resolve /identity/roles (identity:read),
 *  so the app is built per request — mirrors member-service's buildDeps(env, requestId). */
interface ReqCtx {
  requestId: string;
  userId?: string;
}

async function buildApp(env: Env, reqCtx: ReqCtx): Promise<ReturnType<typeof createApp>> {
  const orgId = common.DUB_DEFAULT_ORG_ID;
  const accountStore = createD1GoogleAccountStore(
    createDbClient(env.DB, { namespace: "driveshare", requestId: reqCtx.requestId }),
  );
  const key = await importTokenKey(env.DRIVESHARE_TOKEN_ENC_KEY);
  const googleAccount = createGoogleAccountService({ env, store: accountStore, orgId, key });
  const client = lazyDriveClient(async () =>
    buildDriveClient(env, await resolveDriveCredentials({ env, store: accountStore, orgId, key })),
  );
  const service = createDriveShareService({ client, config: parseConfig(env) });
  // sharedAuthzGranter (not createAuthzGranter): the app is rebuilt per request, so the
  // identity /authz/check TTL cache has to be memoized per Env to survive between requests
  // in the same isolate — otherwise every gated route is an unconditional identity
  // subrequest and identity-roster becomes a hot-path single point of failure (ADR 0004).
  const authz = sharedAuthzGranter(env, env.SVC_IDENTITY, {
    caller: "drive-share-service",
    requestId: reqCtx.requestId,
  });

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

  return createApp({ service, roleGrants, authz, googleAccount });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? newRequestId();
    const userId = request.headers.get("x-dub-user-id") ?? undefined;
    const app = await buildApp(env, { requestId, ...(userId ? { userId } : {}) });
    return app.fetch(request, env, ctx);
  },
};
