// In-memory DeployRepo — a faithful, D1-free implementation of the same DeployRepo
// contract as createD1DeployRepo (repo.ts). It exists in `src/` (not just test/) so
// the cross-service integration harness can wire the REAL deploy-service Hono app +
// routes against an in-memory backend, exactly like identity-roster's MemIdentityRepo
// and event-service's InMemoryEventRepo. Ordering / cursor / single-flight semantics
// match the D1 repo so tests exercising the real app behave identically.
import { newId, nowIso } from "@dub/db";
import type { deploy } from "@dub/types";
import type {
  DeployRepo,
  SiteRow,
  DeploymentRow,
  AllowedZoneRow,
  DnsChangeInput,
  ListDeploymentsArgs,
} from "./repo";

export interface InMemoryDeployRepo extends DeployRepo {
  // Mutable inspection handles (tests/harness read them and may push directly).
  sites: SiteRow[];
  deployments: DeploymentRow[];
  allowedZones: AllowedZoneRow[];
  dnsChanges: DnsChangeInput[];
  /** Test/harness convenience: add a zone to the allow-list. */
  seedAllowedZone(zone: AllowedZoneRow): void;
}

function cmpDesc(a: DeploymentRow, b: DeploymentRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** Construct an in-memory repository backing the deploy_* namespace. */
export function createInMemoryDeployRepo(): InMemoryDeployRepo {
  const sites: SiteRow[] = [];
  const deployments: DeploymentRow[] = [];
  const allowedZones: AllowedZoneRow[] = [];
  const dnsChanges: DnsChangeInput[] = [];

  return {
    sites,
    deployments,
    allowedZones,
    dnsChanges,
    seedAllowedZone(zone) {
      allowedZones.push(zone);
    },

    async createSite(input) {
      const now = nowIso();
      const row: SiteRow = { id: newId("site"), ...input, createdAt: now, updatedAt: now };
      sites.push(row);
      return row;
    },
    async getSite(id) {
      return sites.find((s) => s.id === id) ?? null;
    },
    async getSiteByName(name) {
      return sites.find((s) => s.name === name) ?? null;
    },
    async listSites() {
      // newest-first (createdAt DESC), matching the D1 repo's ORDER BY.
      return [...sites].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },

    async createDeployment(input) {
      const now = nowIso();
      const row: DeploymentRow = {
        id: newId("dep"),
        siteId: input.siteId,
        cfDeploymentId: null,
        status: "queued",
        branch: input.branch,
        commitSha: input.commitSha,
        url: null,
        requestedBy: input.requestedBy,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      };
      deployments.push(row);
      return row;
    },
    async getDeployment(id) {
      return deployments.find((d) => d.id === id) ?? null;
    },
    async listDeployments(args: ListDeploymentsArgs) {
      let rows = [...deployments].sort(cmpDesc);
      if (args.siteId) rows = rows.filter((d) => d.siteId === args.siteId);
      if (args.status) rows = rows.filter((d) => d.status === args.status);
      if (args.cursor) {
        const decoded = Buffer.from(args.cursor, "base64url").toString("utf8").split("|");
        const [ca, id] = decoded;
        if (ca && id) rows = rows.filter((d) => d.createdAt < ca || (d.createdAt === ca && d.id < id));
      }
      const page = rows.slice(0, args.limit);
      const hasMore = rows.length > args.limit;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? Buffer.from(`${last.createdAt}|${last.id}`, "utf8").toString("base64url") : null;
      return { rows: page, nextCursor };
    },
    async hasActiveDeployment(siteId) {
      return deployments.some((d) => d.siteId === siteId && (d.status === "queued" || d.status === "building"));
    },
    async updateDeployment(id, patch) {
      const row = deployments.find((d) => d.id === id);
      if (!row) return;
      Object.assign(row, patch, { updatedAt: nowIso() });
    },

    async isZoneAllowed(zone) {
      return allowedZones.some((z) => z.zoneId === zone || z.zoneName === zone);
    },
    async listAllowedZones() {
      return [...allowedZones].sort((a, b) => (a.zoneName < b.zoneName ? -1 : a.zoneName > b.zoneName ? 1 : 0));
    },
    async recordDnsChange(input: DnsChangeInput) {
      dnsChanges.push(input);
    },
  };
}

// Alias kept for parity with the other services' naming (`new InMemoryEventRepo()`
// style vs factory) — deploy-service uses a factory since the D1 repo is a factory.
export type { DeployRepo } from "./repo";
