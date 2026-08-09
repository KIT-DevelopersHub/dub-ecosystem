// Row -> wire (@dub/types deploy) mappers. The wire shape is deliberately narrower
// than the row (internal columns like cf_project_name / url are never exposed).
import type { deploy } from "@dub/types";
import type { SiteRow, DeploymentRow } from "./repo";

export function toSite(row: SiteRow): deploy.Site {
  return { id: row.id, name: row.name, domain: row.domain, createdAt: row.createdAt };
}

export function toDeployment(row: DeploymentRow): deploy.Deployment {
  return {
    id: row.id,
    siteId: row.siteId,
    status: row.status,
    commitSha: row.commitSha,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
