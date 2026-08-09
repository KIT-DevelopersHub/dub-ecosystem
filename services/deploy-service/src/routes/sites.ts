// Site registry routes. Site creation is infra:admin; listing is infra:read.
// (Site create is NOT in SYNC_AUDIT_ACTIONS, so no synchronous write-ahead audit.)
import { Hono } from "hono";
import type { FieldError } from "@dub/errors";
import { errors } from "@dub/errors";
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
import { toSite } from "../mappers";

export function registerSiteRoutes(app: Hono<AppEnv>): void {
  app.post("/deploy/sites", requireAuth, requirePermission("infra:admin", true), async (c) => {
    const deps = getDeps(c);
    const body = await readJson(c);
    const fe: FieldError[] = [];
    const name = requireString(body, "name", fe);
    const domain = optionalString(body, "domain", fe);
    assertValid(fe);

    const existing = await deps.repo.getSiteByName(name!);
    if (existing) throw errors.conflict(`site name already exists: ${name!}`);

    const ctx = reqCtx(c);
    const row = await deps.repo.createSite({
      name: name!,
      domain: domain ?? null,
      // alpha decision: cfProjectName defaults to the logical name; zone binding is
      // resolved later via allowed zones. defaultBranch defaults to "main".
      cfProjectName: name!,
      zoneId: null,
      defaultBranch: "main",
      createdBy: ctx.userId ?? "system",
    });
    return c.json(toSite(row), 201);
  });

  app.get("/deploy/sites", requireAuth, requirePermission("infra:read"), async (c) => {
    const deps = getDeps(c);
    const rows = await deps.repo.listSites();
    return c.json({ items: rows.map(toSite) });
  });
}
