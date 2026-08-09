// deploy — deploy-service namespace (deployment/DNS/domain/site source of truth).
import type { DeploymentId, ISODateTime, Paginated, CursorQuery } from "./common";

export type DeploymentStatus = "queued" | "building" | "live" | "failed";

export interface Deployment {
  id: DeploymentId;
  siteId: string;
  status: DeploymentStatus;
  commitSha: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
export interface Site {
  id: string;
  name: string;
  domain: string | null;
  createdAt: ISODateTime;
}
export interface Domain {
  name: string;
  siteId: string;
  verified: boolean;
}
export interface CreateDeploymentRequest {
  siteId: string;
  commitSha?: string;
}
export interface CreateSiteRequest {
  name: string;
  domain?: string;
}
export interface CreateDnsRecordRequest {
  zone: string;
  type: "A" | "AAAA" | "CNAME" | "TXT";
  name: string;
  content: string;
}
export interface ListDeploymentsQuery extends CursorQuery {
  siteId?: string;
  status?: DeploymentStatus;
}
export type ListDeploymentsResponse = Paginated<Deployment>;
