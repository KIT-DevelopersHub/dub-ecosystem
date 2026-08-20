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

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* deploy-service's read endpoint
// puts on the wire. The server (deploy-service routes/deployments.ts) and the OpenAPI
// spec (docs/openapi/deploy-service.yaml) are reconciled against this map in CI (see
// @dub/e2e-smoke wire-params.test.ts). Renaming a key here is the only legitimate way to
// change a wire param. See docs/api-contracts/_wire-contract-enforcement.md.
export const DEPLOY_WIRE = {
  listDeployments: {
    method: "GET",
    path: "/deploy/deployments",
    query: ["cursor", "limit", "siteId", "status"],
  },
} as const;

// Compile-time tie: every query key the descriptor lists must be a real key of the
// typed query interface, so the descriptor and the type can never silently drift.
type _DeployWireKeysAreTyped =
  (typeof DEPLOY_WIRE)[keyof typeof DEPLOY_WIRE]["query"][number] extends keyof ListDeploymentsQuery
    ? true
    : never;
const _deployWireKeyGuard: _DeployWireKeysAreTyped = true;
void _deployWireKeyGuard;
