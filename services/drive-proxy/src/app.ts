// Hono app (internal paths — gateway strips API_PREFIX, so routes start at /drive).
// Same contract is shared by external (via api-gateway binding DRIVE) and internal
// Service-Binding callers. authn = trusted header x-dub-user-id (§5); authz = the
// injected PermissionChecker (drive:read / drive:write, §6). Deps are injected so
// the whole surface is unit-testable without a live Worker env.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { errors, dubErrorHandler } from "@dub/errors";
import { newRequestId } from "@dub/http";
import { HDR_REQUEST_ID, HDR_USER_ID, HDR_INTERNAL } from "@dub/observability";
import { common } from "@dub/types";
import type { DriveService } from "./service";
import type { PermissionChecker, DrivePermission } from "./permissions";
import { DRIVE_READ, DRIVE_WRITE } from "./permissions";
import type { PublishContext } from "./events";
import type { MoveFileRequest, WriteSheetValuesRequest } from "./types";

export interface AppDeps {
  service: DriveService;
  authz: PermissionChecker;
}

type Vars = { userId: string };

function requestId(c: Context): string {
  return c.req.header(HDR_REQUEST_ID) ?? newRequestId();
}
function pubCtx(c: Context<{ Variables: Vars }>): PublishContext {
  return { requestId: requestId(c), actorId: c.get("userId") ?? null };
}

async function parseBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  app.onError(dubErrorHandler({ service: "drive-proxy" }));

  const requireAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const userId = c.req.header(HDR_USER_ID);
    if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
    c.set("userId", userId);
    await next();
  };

  const requirePerm = (permission: DrivePermission): MiddlewareHandler<{ Variables: Vars }> => async (c, next) => {
    const allowed = await deps.authz.check(c.get("userId"), common.DUB_DEFAULT_ORG_ID, permission);
    if (!allowed) throw errors.forbidden(`permission denied: ${permission}`);
    await next();
  };

  const requireInternal: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    if (!c.req.header(HDR_INTERNAL)) throw errors.forbidden("internal-only endpoint");
    await next();
  };

  // ---- reads (drive:read) ----
  app.get("/drive/files", requireAuth, requirePerm(DRIVE_READ), async (c) => {
    const q = c.req.query();
    const args = {
      ...(q.folderId ? { folderId: q.folderId } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.q ? { q: q.q } : {}),
    };
    return c.json(await deps.service.list(args));
  });

  app.get("/drive/files/:id/embed", requireAuth, requirePerm(DRIVE_READ), async (c) => {
    return c.json(await deps.service.embed(c.req.param("id")));
  });

  app.get("/drive/files/:id", requireAuth, requirePerm(DRIVE_READ), async (c) => {
    return c.json(await deps.service.get(c.req.param("id")));
  });

  app.get("/drive/sheets/:id/values", requireAuth, requirePerm(DRIVE_READ), async (c) => {
    const range = c.req.query("range") ?? "";
    return c.json(await deps.service.readSheet(c.req.param("id"), range));
  });

  // ---- writes (drive:write) ----
  app.post("/drive/files", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const body = await parseBody<{ name: string; mimeType: string; parentId?: string; templateFileId?: string }>(c);
    const file = await deps.service.create(pubCtx(c), body);
    return c.json({ file }, 201);
  });

  app.post("/drive/files/:id/move", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const body = await parseBody<MoveFileRequest>(c);
    const file = await deps.service.move(pubCtx(c), c.req.param("id"), body.newParentId);
    return c.json({ file });
  });

  app.post("/drive/files/:id/trash", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const { file } = await deps.service.trash(pubCtx(c), c.req.param("id"));
    return c.json({ file, trashed: true });
  });

  app.post("/drive/sheets/:id/values", requireAuth, requirePerm(DRIVE_WRITE), async (c) => {
    const body = await parseBody<WriteSheetValuesRequest>(c);
    return c.json(await deps.service.writeSheet(pubCtx(c), c.req.param("id"), body));
  });

  // ---- internal-only monitoring ----
  app.get("/drive/health/quota", requireInternal, async (c) => {
    return c.json(await deps.service.quota());
  });

  return app;
}
