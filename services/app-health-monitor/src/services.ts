// Backend service health. Each service is probed over its Service Binding /health (or
// /internal/health); api-gateway is probed over public HTTP (/healthz) — the one externally
// reachable service, same liveness the deploy smoke uses.
import type { Fetcher } from "@cloudflare/workers-types";
import { probeBinding, probeHttp } from "./checks";
import { gatewayOrigin, GATEWAY_TARGET, SERVICE_TARGETS } from "./config";
import type { Env } from "./env";
import type { TargetResult } from "./types";

export async function checkServices(env: Env): Promise<TargetResult[]> {
  const results: TargetResult[] = [];

  // api-gateway over public HTTP.
  const gw = await probeHttp(`${gatewayOrigin(env)}${GATEWAY_TARGET.path}`);
  results.push({ id: `svc:${GATEWAY_TARGET.id}`, kind: "service", label: GATEWAY_TARGET.label, status: gw.ok ? "ok" : "down", detail: gw.detail });

  // the rest over Service Bindings.
  for (const t of SERVICE_TARGETS) {
    const fetcher = env[t.binding] as Fetcher | undefined;
    const out = await probeBinding(fetcher, t.path);
    results.push({ id: `svc:${t.id}`, kind: "service", label: t.label, status: out.ok ? "ok" : "down", detail: out.detail });
  }
  return results;
}
