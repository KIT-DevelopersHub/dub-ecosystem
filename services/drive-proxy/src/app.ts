// Hono app (internal paths — gateway strips API_PREFIX, so routes start at /drive).
// Same contract is shared by external (via api-gateway binding DRIVE) and internal
// Service-Binding callers.
//
// AUTHZ: none in this file. `policyGate` is mounted first and derives both authn (the
// trusted x-dub-user-id header, §5) and authz from POLICY_TABLE (src/policy-table.ts),
// which lists every route below. Handlers therefore assume an authorized caller and read
// it with `c.get("userId")`. Do NOT add a permission check — nor a hand-rolled
// `x-dub-internal` guard — to a route or handler; add the route to the table instead
// (test/policy-table.test.ts fails if you forget).
// Deps are injected so the whole surface is unit-testable without a live Worker env.
import { Hono } from "hono";
import type { Context } from "hono";
import { errors, DubError, dubErrorHandler } from "@dub/errors";
import { newRequestId } from "@dub/http";
import { HDR_REQUEST_ID } from "@dub/observability";
import { policyGate, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import type { DriveService } from "./service";
import type { WatchService } from "./watch/service";
import { POLICY_TABLE } from "./policy-table";
import type { PublishContext } from "./events";
import type { MoveFileRequest, WriteSheetValuesRequest } from "./types";

export interface AppDeps {
  service: DriveService;
  /** Which of the requested permission keys the caller holds (identity /authz/check). */
  authz: PermissionGranter;
  /** Drive-watch channel issuance. Absent when no D1 is bound; the routes 500 then. */
  watch?: WatchService;
}

type Vars = PolicyGateVars;

function requestId(c: Context): string {
  return c.req.header(HDR_REQUEST_ID) ?? newRequestId();
}
/** Audit/event context. On an INTERNAL route the gate sets `userId` only when the calling
 *  service propagated one (an ops probe has no acting user), hence the `?? null`. */
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

  // The authorization layer. First and only — every route below is gated by POLICY_TABLE.
  app.use("*", policyGate({ service: "drive-proxy", table: POLICY_TABLE, granted: deps.authz }));

  // ---- liveness (INTERNAL in the table: reachable only over a Service Binding carrying
  // x-dub-internal, which is exactly how app-health-monitor probes it). ----
  app.get("/internal/health", (c) => c.json({ status: "ok", service: "drive-proxy" }));

  // ---- reads (drive:read) ----
  app.get("/drive/files", async (c) => {
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

  app.get("/drive/files/:id/embed", async (c) => {
    return c.json(await deps.service.embed(c.req.param("id")));
  });

  app.get("/drive/files/:id", async (c) => {
    return c.json(await deps.service.get(c.req.param("id")));
  });

  app.get("/drive/sheets/:id/values", async (c) => {
    const range = c.req.query("range") ?? "";
    return c.json(await deps.service.readSheet(c.req.param("id"), range));
  });

  // ---- writes (drive:write) ----
  app.post("/drive/files", async (c) => {
    const body = await parseBody<{ name: string; mimeType: string; parentId?: string; templateFileId?: string }>(c);
    const file = await deps.service.create(pubCtx(c), body);
    return c.json({ file }, 201);
  });

  app.post("/drive/files/:id/move", async (c) => {
    const body = await parseBody<MoveFileRequest>(c);
    const file = await deps.service.move(pubCtx(c), c.req.param("id"), body.newParentId);
    return c.json({ file });
  });

  app.post("/drive/files/:id/trash", async (c) => {
    const { file } = await deps.service.trash(pubCtx(c), c.req.param("id"));
    return c.json({ file, trashed: true });
  });

  app.post("/drive/sheets/:id/values", async (c) => {
    const body = await parseBody<WriteSheetValuesRequest>(c);
    return c.json(await deps.service.writeSheet(pubCtx(c), c.req.param("id"), body));
  });

  // ---- monitoring (INTERNAL in the table) ----
  app.get("/drive/health/quota", async (c) => {
    return c.json(await deps.service.quota());
  });

  // ---- Drive-watch channel administration (P1; INTERNAL in the table) ----
  // Operational endpoints, not user-facing — the table, not a guard here, is what keeps
  // them service-to-service only (and api-gateway 404s them at the edge besides).
  // The response never carries the channel token (secret stays server-side).
  const requireWatch = (): WatchService => {
    if (!deps.watch) {
      throw new DubError("DRIVE_WATCH_UNCONFIGURED", "drive watch is not configured (no D1 bound)", { status: 500 });
    }
    return deps.watch;
  };

  app.post("/drive/watch", async (c) => {
    const watch = requireWatch();
    const body = await parseBody<{ fileId: string; ttlSeconds?: number }>(c);
    const view = await watch.create(pubCtx(c), {
      fileId: body.fileId,
      ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
    });
    return c.json({ channel: view }, 201);
  });

  app.post("/drive/watch/:channelId/stop", async (c) => {
    const watch = requireWatch();
    const result = await watch.stop(pubCtx(c), c.req.param("channelId"));
    return c.json(result);
  });

  return app;
}
