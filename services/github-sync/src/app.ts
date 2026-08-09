// Hono app — the internal HTTP surface (mounted at /github/* behind api-gateway,
// which prepends /api/v1). Routes are declarative; validation + business errors
// come from GithubSyncService, formatting from @dub/errors dubErrorHandler.
import { Hono } from "hono";
import type { Context } from "hono";
import { DubError } from "@dub/errors";
import { dubErrorHandler } from "@dub/errors";
import { dubContext, type RequestContext } from "@dub/http";
import { getUserId, type AuthClient } from "@dub/auth-client";
import { common, type auditLog } from "@dub/types";
import type { GithubSyncService } from "./service";
import type { Publisher } from "./events/publisher";
import { GITHUB_PERMISSIONS, asPermissionKey } from "./auth";
import type { CreateLinkRequest, RegisterRepoRequest, UpdateRepoRequest } from "./domain/types";

export interface AppDeps {
  auth: AuthClient;
  service: GithubSyncService;
  publisher: Publisher;
  now: () => string;
}

type Vars = { dubCtx: RequestContext };

function ctxOf(c: Context): RequestContext {
  return c.get("dubCtx") as RequestContext;
}

async function jsonBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new DubError("GITHUB_VALIDATION_FAILED", "invalid JSON body", { status: 400 });
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars & { authn: unknown } }> {
  const app = new Hono<{ Variables: Vars & { authn: unknown } }>();

  app.onError(dubErrorHandler({ service: "github-sync" }));
  app.use("*", dubContext());
  app.use("*", deps.auth.requireAuth());

  const P = GITHUB_PERMISSIONS;

  // ---- links ----
  app.get("/github/links", deps.auth.requirePermission(asPermissionKey(P.read)), async (c) => {
    const ctx = ctxOf(c);
    const syncState = c.req.queries("syncState");
    const q = {
      ...(c.req.query("taskId") ? { taskId: c.req.query("taskId")! } : {}),
      ...(c.req.query("repo") ? { repo: c.req.query("repo")! } : {}),
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor")! } : {}),
      ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}),
    };
    const res = await deps.service.listLinks(ctx.requestId, q);
    return c.json(res);
  });

  app.post("/github/links", deps.auth.requirePermission(asPermissionKey(P.write)), async (c) => {
    const ctx = ctxOf(c);
    const body = await jsonBody<CreateLinkRequest>(c);
    const link = await deps.service.createLink(ctx.requestId, body);
    return c.json(link, 201);
  });

  app.delete("/github/links/:id", deps.auth.requirePermission(asPermissionKey(P.write)), async (c) => {
    const ctx = ctxOf(c);
    await deps.service.deleteLink(ctx.requestId, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- repos ----
  app.get("/github/repos", deps.auth.requirePermission(asPermissionKey(P.read)), async (c) => {
    const ctx = ctxOf(c);
    const eventId = c.req.query("eventId");
    const cursor = c.req.query("cursor") ?? null;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const res = await deps.service.listRepos(ctx.requestId, eventId, cursor, limit);
    return c.json(res);
  });

  app.post("/github/repos", deps.auth.requirePermission(asPermissionKey(P.admin)), async (c) => {
    const ctx = ctxOf(c);
    const userId = getUserId(c);
    const body = await jsonBody<RegisterRepoRequest>(c);
    const repo = await deps.service.registerRepo(ctx.requestId, userId, body);
    await audit(deps, ctx, userId, "github.repo.registered", repo.id, { owner: repo.owner, repo: repo.repo });
    return c.json(repo, 201);
  });

  app.patch("/github/repos/:id", deps.auth.requirePermission(asPermissionKey(P.admin)), async (c) => {
    const ctx = ctxOf(c);
    const userId = getUserId(c);
    const id = c.req.param("id");
    const body = await jsonBody<UpdateRepoRequest>(c);
    const repo = await deps.service.updateRepo(ctx.requestId, id, body);
    await audit(deps, ctx, userId, "github.repo.updated", id, { changed: Object.keys(body) });
    return c.json(repo);
  });

  app.delete("/github/repos/:id", deps.auth.requirePermission(asPermissionKey(P.admin)), async (c) => {
    const ctx = ctxOf(c);
    const userId = getUserId(c);
    const id = c.req.param("id");
    await deps.service.deleteRepo(ctx.requestId, id);
    await audit(deps, ctx, userId, "github.repo.deregistered", id, null);
    return c.body(null, 204);
  });

  // ---- sync ----
  app.post("/github/sync", deps.auth.requirePermission(asPermissionKey(P.sync)), async (c) => {
    const ctx = ctxOf(c);
    const userId = getUserId(c);
    const body = await jsonBody<Parameters<GithubSyncService["triggerSync"]>[2]>(c);
    const res = await deps.service.triggerSync(ctx.requestId, userId, body);
    await audit(deps, ctx, userId, "github.sync.triggered", res.runId, { scope: body.scope });
    return c.json(res, 202);
  });

  app.get("/github/sync/runs", deps.auth.requirePermission(asPermissionKey(P.read)), async (c) => {
    const cursor = c.req.query("cursor") ?? null;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const res = await deps.service.listRuns(cursor, limit);
    return c.json(res);
  });

  app.get("/github/sync/runs/:id", deps.auth.requirePermission(asPermissionKey(P.read)), async (c) => {
    const run = await deps.service.getRun(c.req.param("id"));
    return c.json(run);
  });

  return app;
}

async function audit(
  deps: AppDeps,
  ctx: RequestContext,
  userId: string,
  action: string,
  resourceId: string,
  details: Record<string, unknown> | null,
): Promise<void> {
  const rec: auditLog.AuditRecordInput = {
    action,
    actorId: userId,
    orgId: common.DUB_DEFAULT_ORG_ID,
    result: "success",
    resourceType: "github_repo",
    resourceId,
    details,
    requestId: ctx.requestId,
    occurredAt: deps.now(),
  };
  await deps.publisher.audit(rec);
}
