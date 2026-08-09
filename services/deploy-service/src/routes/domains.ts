// Domain/zone listing (infra:read). Merges the live CF zone list with the local
// allowed-zone table. NOTE: the frozen deploy.Domain shape ({name, siteId, verified})
// is narrower than a CF zone; `verified` carries the allowed-list flag and `siteId`
// is left empty (zones are not 1:1 with sites in P0). Divergence tracked in notes.
import { Hono } from "hono";
import type { deploy } from "@dub/types";
import type { AppEnv } from "../http";
import { getDeps, requireAuth, requirePermission } from "../http";

export function registerDomainRoutes(app: Hono<AppEnv>): void {
  app.get("/deploy/domains", requireAuth, requirePermission("infra:read"), async (c) => {
    const deps = getDeps(c);
    const [zones, allowed] = await Promise.all([deps.cf.listZones(), deps.repo.listAllowedZones()]);
    const allowedByName = new Set(allowed.map((z) => z.zoneName));
    const allowedById = new Set(allowed.map((z) => z.zoneId));

    const items: deploy.Domain[] = zones.map((z) => ({
      name: z.zoneName,
      siteId: "",
      verified: allowedByName.has(z.zoneName) || allowedById.has(z.zoneId),
    }));
    // include allowed zones not returned by CF (e.g. read-token scoping) so the
    // allow-list is always fully observable.
    for (const z of allowed) {
      if (!zones.some((cf) => cf.zoneName === z.zoneName)) {
        items.push({ name: z.zoneName, siteId: "", verified: true });
      }
    }
    return c.json({ items });
  });
}
