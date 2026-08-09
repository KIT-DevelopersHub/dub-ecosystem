// Data access for the deploy_* namespace. The contract types (@dub/types deploy)
// are intentionally lean, so rows carry a few internal columns (cf_project_name,
// default_branch, zone_id, cf_deployment_id, url) that are NOT exposed on the wire.
import type { DbClient } from "@dub/db";
import { newId, nowIso } from "@dub/db";
import type { deploy } from "@dub/types";

export interface SiteRow {
  id: string;
  name: string;
  domain: string | null;
  cfProjectName: string;
  zoneId: string | null;
  defaultBranch: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentRow {
  id: string;
  siteId: string;
  cfDeploymentId: string | null;
  status: deploy.DeploymentStatus;
  branch: string;
  commitSha: string | null;
  url: string | null;
  requestedBy: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AllowedZoneRow {
  zoneId: string;
  zoneName: string;
  registrarManaged: boolean;
}

export interface DnsChangeInput {
  zone: string;
  recordId: string | null;
  op: "create" | "update" | "delete";
  recordType: string;
  recordName: string;
  recordContent: string | null;
  requestedBy: string;
  status: "applied" | "failed";
  errorMessage: string | null;
}

const ACTIVE_STATUSES: readonly deploy.DeploymentStatus[] = ["queued", "building"];

export interface ListDeploymentsArgs {
  siteId?: string;
  status?: deploy.DeploymentStatus;
  cursor?: string;
  limit: number;
}

export interface DeployRepo {
  createSite(input: {
    name: string;
    domain: string | null;
    cfProjectName: string;
    zoneId: string | null;
    defaultBranch: string;
    createdBy: string;
  }): Promise<SiteRow>;
  getSite(id: string): Promise<SiteRow | null>;
  getSiteByName(name: string): Promise<SiteRow | null>;
  listSites(): Promise<SiteRow[]>;

  createDeployment(input: {
    siteId: string;
    branch: string;
    commitSha: string | null;
    requestedBy: string;
  }): Promise<DeploymentRow>;
  getDeployment(id: string): Promise<DeploymentRow | null>;
  listDeployments(args: ListDeploymentsArgs): Promise<{ rows: DeploymentRow[]; nextCursor: string | null }>;
  hasActiveDeployment(siteId: string): Promise<boolean>;
  updateDeployment(
    id: string,
    patch: Partial<Pick<DeploymentRow, "status" | "cfDeploymentId" | "url" | "errorMessage" | "finishedAt">>,
  ): Promise<void>;

  isZoneAllowed(zone: string): Promise<boolean>;
  listAllowedZones(): Promise<AllowedZoneRow[]>;
  recordDnsChange(input: DnsChangeInput): Promise<void>;
}

function encodeCursor(row: DeploymentRow): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

interface SiteDbRow {
  id: string;
  name: string;
  domain: string | null;
  cf_project_name: string;
  zone_id: string | null;
  default_branch: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface DeploymentDbRow {
  id: string;
  site_id: string;
  cf_deployment_id: string | null;
  status: deploy.DeploymentStatus;
  branch: string;
  commit_sha: string | null;
  url: string | null;
  requested_by: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function toSiteRow(r: SiteDbRow): SiteRow {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    cfProjectName: r.cf_project_name,
    zoneId: r.zone_id,
    defaultBranch: r.default_branch,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toDeploymentRow(r: DeploymentDbRow): DeploymentRow {
  return {
    id: r.id,
    siteId: r.site_id,
    cfDeploymentId: r.cf_deployment_id,
    status: r.status,
    branch: r.branch,
    commitSha: r.commit_sha,
    url: r.url,
    requestedBy: r.requested_by,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

/** D1-backed repository over the deploy_* namespace (strict boundary via @dub/db). */
export function createD1DeployRepo(db: DbClient): DeployRepo {
  return {
    async createSite(input) {
      const now = nowIso();
      const id = newId("site");
      await db.run(
        `INSERT INTO deploy_sites (id, name, domain, cf_project_name, zone_id, default_branch, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        input.domain,
        input.cfProjectName,
        input.zoneId,
        input.defaultBranch,
        input.createdBy,
        now,
        now,
      );
      return {
        id,
        name: input.name,
        domain: input.domain,
        cfProjectName: input.cfProjectName,
        zoneId: input.zoneId,
        defaultBranch: input.defaultBranch,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };
    },
    async getSite(id) {
      const r = await db.first<SiteDbRow>(`SELECT * FROM deploy_sites WHERE id = ?`, id);
      return r ? toSiteRow(r) : null;
    },
    async getSiteByName(name) {
      const r = await db.first<SiteDbRow>(`SELECT * FROM deploy_sites WHERE name = ?`, name);
      return r ? toSiteRow(r) : null;
    },
    async listSites() {
      const rows = await db.all<SiteDbRow>(`SELECT * FROM deploy_sites ORDER BY created_at DESC`);
      return rows.map(toSiteRow);
    },

    async createDeployment(input) {
      const now = nowIso();
      const id = newId("dep");
      await db.run(
        `INSERT INTO deploy_deployments
           (id, site_id, cf_deployment_id, status, branch, commit_sha, url, requested_by, error_message, created_at, updated_at, finished_at)
         VALUES (?, ?, NULL, 'queued', ?, ?, NULL, ?, NULL, ?, ?, NULL)`,
        id,
        input.siteId,
        input.branch,
        input.commitSha,
        input.requestedBy,
        now,
        now,
      );
      return {
        id,
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
    },
    async getDeployment(id) {
      const r = await db.first<DeploymentDbRow>(`SELECT * FROM deploy_deployments WHERE id = ?`, id);
      return r ? toDeploymentRow(r) : null;
    },
    async listDeployments(args) {
      const clauses: string[] = [];
      const binds: unknown[] = [];
      if (args.siteId) {
        clauses.push(`site_id = ?`);
        binds.push(args.siteId);
      }
      if (args.status) {
        clauses.push(`status = ?`);
        binds.push(args.status);
      }
      if (args.cursor) {
        const c = decodeCursor(args.cursor);
        if (c) {
          clauses.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
          binds.push(c.createdAt, c.createdAt, c.id);
        }
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await db.all<DeploymentDbRow>(
        `SELECT * FROM deploy_deployments ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...binds,
        args.limit + 1,
      );
      const page = rows.slice(0, args.limit).map(toDeploymentRow);
      const last = page.length === args.limit ? page[page.length - 1] : undefined;
      const nextCursor = rows.length > args.limit && last ? encodeCursor(last) : null;
      return { rows: page, nextCursor };
    },
    async hasActiveDeployment(siteId) {
      const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
      const r = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM deploy_deployments WHERE site_id = ? AND status IN (${placeholders})`,
        siteId,
        ...ACTIVE_STATUSES,
      );
      return (r?.n ?? 0) > 0;
    },
    async updateDeployment(id, patch) {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.status !== undefined) {
        sets.push(`status = ?`);
        binds.push(patch.status);
      }
      if (patch.cfDeploymentId !== undefined) {
        sets.push(`cf_deployment_id = ?`);
        binds.push(patch.cfDeploymentId);
      }
      if (patch.url !== undefined) {
        sets.push(`url = ?`);
        binds.push(patch.url);
      }
      if (patch.errorMessage !== undefined) {
        sets.push(`error_message = ?`);
        binds.push(patch.errorMessage);
      }
      if (patch.finishedAt !== undefined) {
        sets.push(`finished_at = ?`);
        binds.push(patch.finishedAt);
      }
      sets.push(`updated_at = ?`);
      binds.push(nowIso());
      binds.push(id);
      await db.run(`UPDATE deploy_deployments SET ${sets.join(", ")} WHERE id = ?`, ...binds);
    },

    async isZoneAllowed(zone) {
      const r = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM deploy_allowed_zones WHERE zone_id = ? OR zone_name = ?`,
        zone,
        zone,
      );
      return (r?.n ?? 0) > 0;
    },
    async listAllowedZones() {
      const rows = await db.all<{ zone_id: string; zone_name: string; registrar_managed: number }>(
        `SELECT zone_id, zone_name, registrar_managed FROM deploy_allowed_zones ORDER BY zone_name ASC`,
      );
      return rows.map((r) => ({
        zoneId: r.zone_id,
        zoneName: r.zone_name,
        registrarManaged: r.registrar_managed === 1,
      }));
    },
    async recordDnsChange(input) {
      await db.run(
        `INSERT INTO deploy_dns_changes
           (id, zone_id, record_id, op, record_type, record_name, record_content, requested_by, status, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId("dnsc"),
        input.zone,
        input.recordId,
        input.op,
        input.recordType,
        input.recordName,
        input.recordContent,
        input.requestedBy,
        input.status,
        input.errorMessage,
        nowIso(),
      );
    },
  };
}
