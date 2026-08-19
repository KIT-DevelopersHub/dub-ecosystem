// Hono app (internal paths — the gateway strips API_PREFIX, so routes start at
// /driveshare). Same contract for external (via api-gateway binding SVC_DRIVE_SHARE)
// and internal Service-Binding callers. authn = trusted header x-dub-user-id; authz =
// the injected PermissionChecker (drive:read for reads, drive:write for mutations).
// Deps are injected so the whole surface is unit-testable without a live Worker env.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { errors, dubErrorHandler } from "@dub/errors";
import { HDR_USER_ID } from "@dub/observability";
import { common } from "@dub/types";
import type { DriveShareService } from "./service";
import type { RoleGrantsService } from "./role-grants-service";
import type { PermissionChecker, DrivePermission } from "./permissions";
import { DRIVE_READ, DRIVE_WRITE } from "./permissions";
import type { CreateRoleGrantRequest, GrantPermissionRequest, SetLinkSharingRequest, UpdatePermissionRequest } from "./types";

export interface AppDeps {
  service: DriveShareService;
  /** Role-based sharing fan-out (built per request with the acting user's roster view). */
  roleGrants: RoleGrantsService;
  authz: PermissionChecker;
}

type Vars = { userId: string };

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

  // ---- liveness (unauthenticated; app-health-monitor probes this over the Service Binding).
  app.get("/internal/health", (c) => c.json({ status: "ok", service: "drive-share-service" }));

  const requireAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const userId = c.req.header(HDR_USER_ID);
    if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
    c.set("userId", userId);
    await next();
  };

  const requirePerm =
    (permission: DrivePermission): MiddlewareHandler<{ Variables: Vars }> =>
    async (c, next) => {
      const allowed = await deps.authz.check(c.get("userId"), common.DUB_DEFAULT_ORG_ID, permission);
      if (!allowed) throw errors.forbidden(`permission denied: ${permission}`);
      await next();
    };

  // ---- reads (drive:read) ----
  app.get("/driveshare/files", requireAuth, requirePerm(DRIVE_READ), async (c) => {
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

  app.get("/driveshare/files/:id/permissions", requireAuth, requirePerm(DRIVE_READ), async (c) => {
    return c.json(await deps.service.listPermissions(c.req.param("id")));
  });

  // ---- role-based sharing reads (drive:read) ----
  // All grants in the org — the file list renders role chips from this.
  app.get("/driveshare/role-grants", requireAuth, requirePerm(DRIVE_READ), async (c) => {
    return c.json({ items: await deps.roleGrants.listAll() });
  });

  // Grants for one file — the detail panel.
  app.get("/driveshare/files/:id/role-grants", requireAuth, requirePerm(DRIVE_READ), async (c) => {
    return c.json({ items: await deps.roleGrants.listByFile(c.req.param("id")) });
  });

  // ---- writes (drive:write) ----
  app.post("/driveshare/files/:id/permissions", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const body = await parseBody<GrantPermissionRequest>(c);
    const permission = await deps.service.grant(c.req.param("id"), body);
    return c.json({ permission }, 201);
  });

  app.patch("/driveshare/files/:id/permissions/:permId", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const body = await parseBody<UpdatePermissionRequest>(c);
    const permission = await deps.service.updateRole(c.req.param("id"), c.req.param("permId"), body);
    return c.json({ permission });
  });

  app.delete("/driveshare/files/:id/permissions/:permId", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    await deps.service.revoke(c.req.param("id"), c.req.param("permId"));
    return c.json({ revoked: true });
  });

  // ---- role-based sharing writes (drive:write) ----
  // UPSERT a role→file grant, then non-destructively fan out to the role's members.
  app.post("/driveshare/files/:id/role-grants", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const body = await parseBody<CreateRoleGrantRequest>(c);
    const grant = await deps.roleGrants.apply(c.req.param("id"), c.get("userId"), body.roleId, body.driveRole);
    return c.json(grant, 201);
  });

  // Revoke a role→file grant: delete only the permissions we created (guarded), drop rows.
  app.delete("/driveshare/files/:id/role-grants/:roleId", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    await deps.roleGrants.revoke(c.req.param("id"), c.req.param("roleId"));
    return c.body(null, 204);
  });

  // Reconcile a grant against current role membership (add new, remove departed).
  app.post("/driveshare/files/:id/role-grants/:roleId/reapply", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    return c.json(await deps.roleGrants.reapply(c.req.param("id"), c.req.param("roleId")));
  });

  // ---- link sharing on/off (drive:write) ----
  app.put("/driveshare/files/:id/link", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const body = await parseBody<SetLinkSharingRequest>(c);
    return c.json(await deps.service.setLinkSharing(c.req.param("id"), body));
  });

  return app;
}
