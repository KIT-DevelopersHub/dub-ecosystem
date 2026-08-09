// Cloudflare API client — the ONLY place that talks to the CF control plane.
// Strong-privilege tokens are injected here and nowhere else (design §1/§5).
// The interface is what the rest of the service depends on; tests inject a fake so
// no unit test ever touches a real CF account (design §7).
import { retryFetch } from "@dub/http";
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { deploy } from "@dub/types";

export interface CfPagesDeployResult {
  cfDeploymentId: string;
  // CF maps to our frozen enum: queued|building|live|failed. "success" -> "live".
  status: deploy.DeploymentStatus;
  url: string | null;
}

export interface CfDnsRecordResult {
  id: string;
  zone: string;
  type: string;
  name: string;
  content: string;
}

export interface CfZone {
  zoneId: string;
  zoneName: string;
  status: "active" | "pending" | "moved";
  registrarManaged: boolean;
}

export interface CfClient {
  createPagesDeployment(input: {
    cfProjectName: string;
    branch: string;
    commitSha: string | null;
  }): Promise<CfPagesDeployResult>;
  getPagesDeployment(input: {
    cfProjectName: string;
    cfDeploymentId: string;
  }): Promise<CfPagesDeployResult>;
  createDnsRecord(input: {
    zone: string;
    type: string;
    name: string;
    content: string;
  }): Promise<CfDnsRecordResult>;
  listZones(): Promise<CfZone[]>;
}

export interface CfClientConfig {
  accountId: string;
  apiBase?: string; // default https://api.cloudflare.com/client/v4
  tokenPages: string;
  tokenDns: string;
  tokenRead: string;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

/** Map CF Pages deployment stage to the frozen DeploymentStatus enum. */
export function mapPagesStage(stage: string | undefined): deploy.DeploymentStatus {
  switch (stage) {
    case "queued":
    case "initialize":
      return "queued";
    case "success":
    case "live":
    case "active":
      return "live";
    case "failure":
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "building";
  }
}

/** Real CF client. Uses retryFetch (external HTTPS discipline; no x-dub-* headers). */
export function createCfClient(config: CfClientConfig): CfClient {
  const base = (config.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");

  async function call<T>(token: string, path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await retryFetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
        timeoutMs: 8000,
      });
    } catch (cause) {
      throw new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "Cloudflare API unreachable", {
        status: 502,
        service: "cloudflare",
        cause,
      });
    }
    if (res.status === 429) {
      throw new DubError(CommonErrorCodes.RATE_LIMITED, "Cloudflare API rate limited", {
        status: 429,
        details: { retryAfterSec: Number(res.headers.get("retry-after") ?? 1) },
      });
    }
    const body = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !body || body.success === false) {
      const msg = body?.errors?.map((e) => e.message).join("; ") ?? `CF API error ${res.status}`;
      throw new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, `Cloudflare API failed: ${msg}`, {
        status: 502,
        service: "cloudflare",
      });
    }
    return body.result;
  }

  return {
    async createPagesDeployment(input) {
      const r = await call<{ id: string; latest_stage?: { name?: string }; url?: string }>(
        config.tokenPages,
        `/accounts/${config.accountId}/pages/projects/${encodeURIComponent(input.cfProjectName)}/deployments`,
        { method: "POST", body: JSON.stringify({ branch: input.branch }) },
      );
      return { cfDeploymentId: r.id, status: mapPagesStage(r.latest_stage?.name), url: r.url ?? null };
    },
    async getPagesDeployment(input) {
      const r = await call<{ id: string; latest_stage?: { name?: string }; url?: string }>(
        config.tokenPages,
        `/accounts/${config.accountId}/pages/projects/${encodeURIComponent(input.cfProjectName)}/deployments/${encodeURIComponent(input.cfDeploymentId)}`,
      );
      return { cfDeploymentId: r.id, status: mapPagesStage(r.latest_stage?.name), url: r.url ?? null };
    },
    async createDnsRecord(input) {
      const r = await call<{ id: string; type: string; name: string; content: string }>(
        config.tokenDns,
        `/zones/${encodeURIComponent(input.zone)}/dns_records`,
        {
          method: "POST",
          body: JSON.stringify({ type: input.type, name: input.name, content: input.content }),
        },
      );
      return { id: r.id, zone: input.zone, type: r.type, name: r.name, content: r.content };
    },
    async listZones() {
      const r = await call<Array<{ id: string; name: string; status: string }>>(
        config.tokenRead,
        `/zones?per_page=50`,
      );
      return r.map((z) => ({
        zoneId: z.id,
        zoneName: z.name,
        status: (z.status === "active" || z.status === "pending" ? z.status : "moved") as CfZone["status"],
        registrarManaged: false, // Registrar detail requires a separate call; P0 defaults false
      }));
    },
  };
}
