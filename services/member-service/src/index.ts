// Worker entrypoint. Wires the runtime env (D1, identity Service Binding) into
// AppDeps and serves the Hono app. Must stay import-clean for `wrangler dev`.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { common } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { createD1MemberRepo } from "./d1-repo";
import type { Env } from "./env";
import type { AppDeps } from "./types";

export type { Env } from "./env";

export function buildDeps(env: Env, requestId?: string): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "member",
    ...(requestId ? { requestId } : {}),
    logger: (e) =>
      consoleSink({ level: "debug", message: "db", service: "member-service", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  const authz = createAuthClient({
    identityBinding: env.SVC_IDENTITY,
    serviceName: "member-service",
    mode: "trustedHeader",
  });
  return {
    repo: createD1MemberRepo(db),
    authz,
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    now: nowIso,
    newTeamId: () => newId("team"),
    newMemberId: () => newId("member"),
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
export { MemberService } from "./service";
export { createD1MemberRepo } from "./d1-repo";
export { InMemoryMemberRepo } from "./memory-repo";
export { MEMBER_SCHEMA_MIGRATION, MEMBER_IDENTITY_LINK_MIGRATION, MEMBER_MIGRATIONS } from "./schema";
export type { AppDeps } from "./types";
