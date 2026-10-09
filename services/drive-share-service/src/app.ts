// Hono app (internal paths — the gateway strips API_PREFIX, so routes start at
// /driveshare). Same contract for external (via api-gateway binding SVC_DRIVE_SHARE)
// and internal Service-Binding callers.
//
// AUTHZ: none in this file. `policyGate` is mounted first and derives both authn (the
// trusted x-dub-user-id header) and authz from POLICY_TABLE (src/policy-table.ts), which
// lists every route below. Handlers therefore assume an authorized caller and read it with
// `c.get("userId")`. Do NOT add a permission check to a route or a handler — add the route
// to the table (test/policy-table.test.ts fails if you forget).
// Deps are injected so the whole surface is unit-testable without a live Worker env.
import { Hono } from "hono";
import type { Context } from "hono";
import { errors, dubErrorHandler } from "@dub/errors";
import { policyGate, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import type { DriveShareService } from "./service";
import type { RoleGrantsService } from "./role-grants-service";
import type { GoogleAccountService } from "./google-account";
import { POLICY_TABLE } from "./policy-table";
import type {
  CompleteGoogleConnectRequest,
  CreateRoleGrantRequest,
  GrantPermissionRequest,
  SetLinkSharingRequest,
  StartGoogleConnectRequest,
  UpdatePermissionRequest,
} from "./types";

export interface AppDeps {
  service: DriveShareService;
  /** Role-based sharing fan-out (built per request with the acting user's roster view). */
  roleGrants: RoleGrantsService;
  /** The Google account the service acts as + the admin connect flow. */
  googleAccount: GoogleAccountService;
  /** Which of the requested permission keys the caller holds (identity /authz/check). */
  authz: PermissionGranter;
}

type Vars = PolicyGateVars;

async function parseBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  app.onError(dubErrorHandler({ service: "drive-share-service" }));

  // The authorization layer. First and only — every route below is gated by POLICY_TABLE.
  app.use("*", policyGate({ service: "drive-share-service", table: POLICY_TABLE, granted: deps.authz }));

  // ---- liveness (INTERNAL in the table: reachable only over a Service Binding carrying
  // x-dub-internal, which is exactly how app-health-monitor probes it). ----
  app.get("/internal/health", (c) => c.json({ status: "ok", service: "drive-share-service" }));

  // ---- reads ----
  app.get("/driveshare/files", async (c) => {
    const q = c.req.query();
    return c.json(
      await deps.service.listFiles({
        ...(q.folderId ? { folderId: q.folderId } : {}),
        ...(q.q ? { q: q.q } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      }),
    );
  });

  app.get("/driveshare/files/:id/permissions", async (c) => {
    return c.json(await deps.service.listPermissions(c.req.param("id")));
  });

  // ---- role-based sharing reads ----
  // All grants in the org — the file list renders role chips from this.
  app.get("/driveshare/role-grants", async (c) => {
    return c.json({ items: await deps.roleGrants.listAll() });
  });

  // Grants for one file — the detail panel.
  app.get("/driveshare/files/:id/role-grants", async (c) => {
    return c.json({ items: await deps.roleGrants.listByFile(c.req.param("id")) });
  });

  // ---- writes ----
  app.post("/driveshare/files/:id/permissions", async (c) => {
    const body = await parseBody<GrantPermissionRequest>(c);
    const permission = await deps.service.grant(c.req.param("id"), body);
    return c.json({ permission }, 201);
  });

  app.patch("/driveshare/files/:id/permissions/:permId", async (c) => {
    const body = await parseBody<UpdatePermissionRequest>(c);
    const permission = await deps.service.updateRole(c.req.param("id"), c.req.param("permId"), body);
    return c.json({ permission });
  });

  app.delete("/driveshare/files/:id/permissions/:permId", async (c) => {
    await deps.service.revoke(c.req.param("id"), c.req.param("permId"));
    return c.json({ revoked: true });
  });

  // ---- role-based sharing writes ----
  // UPSERT a role→file grant, then non-destructively fan out to the role's members.
  app.post("/driveshare/files/:id/role-grants", async (c) => {
    const body = await parseBody<CreateRoleGrantRequest>(c);
    const grant = await deps.roleGrants.apply(c.req.param("id"), c.get("userId"), body.roleId, body.driveRole);
    return c.json(grant, 201);
  });

  // Revoke a role→file grant: delete only the permissions we created (guarded), drop rows.
  app.delete("/driveshare/files/:id/role-grants/:roleId", async (c) => {
    await deps.roleGrants.revoke(c.req.param("id"), c.req.param("roleId"));
    return c.body(null, 204);
  });

  // Reconcile a grant against current role membership (add new, remove departed).
  app.post("/driveshare/files/:id/role-grants/:roleId/reapply", async (c) => {
    return c.json(await deps.roleGrants.reapply(c.req.param("id"), c.req.param("roleId")));
  });

  // ---- link sharing on/off ----
  app.put("/driveshare/files/:id/link", async (c) => {
    const body = await parseBody<SetLinkSharingRequest>(c);
    return c.json(await deps.service.setLinkSharing(c.req.param("id"), body));
  });

  // ---- Google account the service acts as (ロール管理 > Drive共有 詳細ダイアログ; admin only) ----
  app.get("/driveshare/google-account", async (c) => c.json(await deps.googleAccount.status()));

  app.post("/driveshare/google-account/connect", async (c) => {
    const body = await parseBody<Partial<StartGoogleConnectRequest>>(c);
    return c.json(await deps.googleAccount.startConnect(c.get("userId"), body.redirectUri));
  });

  app.post("/driveshare/google-account/callback", async (c) => {
    const body = await parseBody<Partial<CompleteGoogleConnectRequest>>(c);
    return c.json(await deps.googleAccount.completeConnect(c.get("userId"), body));
  });

  return app;
}
