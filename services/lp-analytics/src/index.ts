// Worker entrypoint. Wires the runtime env (D1, identity Service Binding) into AppDeps.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { common } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { createD1LpRepo } from "./d1-repo";
import type { Env } from "./env";
import type { AppDeps } from "./types";

export type { Env } from "./env";

// Not exported: workerd treats every named export of the entry module as an entrypoint,
// so a non-handler export (e.g. a string) makes the Worker fail to boot.
const DEFAULT_LP_BASE_URL = "https://hokuriku-it-conf.com";
const DEFAULT_DAILY_VISIT_CAP = 5000;

export function buildDeps(env: Env, requestId?: string): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "lp",
    ...(requestId ? { requestId } : {}),
    logger: (e) =>
      consoleSink({ level: "debug", message: "db", service: "lp-analytics", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  return {
    repo: createD1LpRepo(db),
    authz: createAuthClient({ identityBinding: env.SVC_IDENTITY, serviceName: "lp-analytics", mode: "trustedHeader" }),
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    lpBaseUrl: env.LP_BASE_URL ?? DEFAULT_LP_BASE_URL,
    now: nowIso,
    newLinkId: () => newId("lnk"),
    newVisitId: () => newId("lpv"),
    dailyVisitCap: Number(env.LP_DAILY_VISIT_CAP) > 0 ? Number(env.LP_DAILY_VISIT_CAP) : DEFAULT_DAILY_VISIT_CAP,
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const app = createApp(buildDeps(env, requestId));
    return app.fetch(request as unknown as Request) as unknown as Response;
  },
};

export { createApp } from "./app";
export { createD1LpRepo } from "./d1-repo";
export { InMemoryLpRepo } from "./memory-repo";
