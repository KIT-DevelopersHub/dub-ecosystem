// Backend service health. Each service (incl. the api-gateway) is probed over its Service
// Binding /health (or /internal/health, or the gateway's /healthz) — never public fetch, since
// same-account workers.dev subrequests loop back to 404 (see checks.ts).
import type { Fetcher } from "@cloudflare/workers-types";
import { probeBinding } from "./checks";
import { SERVICE_TARGETS } from "./config";
import type { Env } from "./env";
import type { TargetResult } from "./types";

export async function checkServices(env: Env): Promise<TargetResult[]> {
  const results: TargetResult[] = [];
  for (const t of SERVICE_TARGETS) {
    const fetcher = env[t.binding] as Fetcher | undefined;
    const out = await probeBinding(fetcher, t.path);
    results.push({ id: `svc:${t.id}`, kind: "service", label: t.label, status: out.ok ? "ok" : "down", detail: out.detail });
  }
  return results;
}
