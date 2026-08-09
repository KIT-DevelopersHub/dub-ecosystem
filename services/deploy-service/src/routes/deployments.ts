// Deployment routes. POST is async (202): write-ahead intent audit -> persist queued
// row -> enqueue the private deploy-jobs message. The CF call + result audit + status
// event happen in the queue consumer (see queue.ts).
import { Hono } from "hono";
import type { FieldError } from "@dub/errors";
import { errors } from "@dub/errors";
import type { deploy } from "@dub/types";
import type { AppEnv } from "../http";
import {
  getDeps,
  reqCtx,
  requireAuth,
  requirePermission,
  readJson,
  requireString,
  optionalString,
  assertValid,
} from "../http";
import { toDeployment } from "../mappers";
import type { DeployJobMessage } from "../jobs";

const VALID_STATUSES: readonly deploy.DeploymentStatus[] = ["queued", "building", "live", "failed"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function registerDeploymentRoutes(app: Hono<AppEnv>): void {
  app.post("/deploy/deployments", requireAuth, requirePermission("infra:deploy", true), async (c) => {
    const deps = getDeps(c);
    const body = await readJson(c);
    const fe: FieldError[] = [];
    const siteId = requireString(body, "siteId", fe);
    const commitSha = optionalString(body, "commitSha", fe);
    assertValid(fe);

    const site = await deps.repo.getSite(siteId!);
    if (!site) throw errors.notFound("site", siteId!);

    // multiple-execution guard (design test #4)
    if (await deps.repo.hasActiveDeployment(site.id)) {
      throw errors.conflict(`a deployment is already in flight for site ${site.id}`);
    }

    const ctx = reqCtx(c);
    // write-ahead intent (sync, fail-close): a 502 here means the CF call never happens.
    const intentId = await deps.audit.recordIntent(ctx, {
      action: "infra.deploy.executed",
      actorId: ctx.userId ?? null,
      resourceType: "site",
      resourceId: site.id,
      details: { siteId: site.id, branch: site.defaultBranch, commitSha: commitSha ?? null },
    });

    const row = await deps.repo.createDeployment({
      siteId: site.id,
      branch: site.defaultBranch,
      commitSha: commitSha ?? null,
      requestedBy: ctx.userId ?? "system",
    });

    const job: DeployJobMessage = {
      tag: "deploy-job/v1",
      kind: "execute",
      deploymentId: row.id,
      siteId: site.id,
      cfProjectName: site.cfProjectName,
      branch: site.defaultBranch,
      commitSha: commitSha ?? null,
      requestId: ctx.requestId,
      actorId: ctx.userId ?? null,
      intentId,
      attempt: 0,
    };
    await deps.enqueueJob(job);

    return c.json(toDeployment(row), 202);
  });

  app.get("/deploy/deployments", requireAuth, requirePermission("infra:read"), async (c) => {
    const deps = getDeps(c);
    const siteId = c.req.query("siteId");
    const statusRaw = c.req.query("status");
    const cursor = c.req.query("cursor");
    const limit = clampLimit(c.req.query("limit"));

    let status: deploy.DeploymentStatus | undefined;
    if (statusRaw !== undefined) {
      if (!VALID_STATUSES.includes(statusRaw as deploy.DeploymentStatus)) {
        throw errors.validationFailed([{ field: "status", reason: "invalid" }]);
      }
      status = statusRaw as deploy.DeploymentStatus;
    }

    const { rows, nextCursor } = await deps.repo.listDeployments({
      ...(siteId ? { siteId } : {}),
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    });
    const res: deploy.ListDeploymentsResponse = { items: rows.map(toDeployment), nextCursor };
    return c.json(res);
  });

  app.get("/deploy/deployments/:id", requireAuth, requirePermission("infra:read"), async (c) => {
    const deps = getDeps(c);
    const id = c.req.param("id");
    const row = await deps.repo.getDeployment(id);
    if (!row) throw errors.notFound("deployment", id);
    return c.json(toDeployment(row));
  });
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}
