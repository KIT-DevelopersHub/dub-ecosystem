// Cloudflare Worker entrypoint. Builds the app over the D1-backed repo and the
// binding-backed sinks per request. Deploy is out of scope for the P0 unit
// (wrangler.toml is a documented skeleton).
import { createDbClient, newId, nowIso } from "@dub/db";
import { common } from "@dub/types";
import { createApp } from "./app";
import { D1IdentityRepo } from "./repo/d1-repo";
import { createAuditSink, createSessionRevoker } from "./sinks";
import type { Env } from "./env";

// Typed against the ambient Request/Response (shared by Hono + the Workers
// runtime) rather than @cloudflare/workers-types' ExportedHandler, so this file
// typechecks under both the service tsconfig (workers-types global) and the root
// tsconfig (node only). ctx is passed opaquely to Hono for waitUntil support.
const handler = {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const db = createDbClient(env.DB, { namespace: "identity", ...(requestId ? { requestId } : {}) });
    const repo = new D1IdentityRepo(db);
    const defaultOrgId = env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID;
    const app = createApp({
      deps: {
        repo,
        audit: createAuditSink(env),
        revoker: createSessionRevoker(env),
        now: nowIso,
        newId,
        defaultOrgId,
      },
      defaultOrgId,
    });
    return app.fetch(request, env as unknown as Record<string, unknown>, ctx as Parameters<typeof app.fetch>[2]);
  },

  // NOTE: no scheduled() drain here. The freeq audit outbox is drained centrally by the
  // standalone freeq-drain worker (single aggregated cron). src/drain.ts is retained as
  // the topic->destination contract source (audit.record) for freeq-drain's routing.
};

export default handler;
export type { Env } from "./env";
// NOTE: the Worker entry module must export ONLY the default handler (plus type-only
// re-exports, which are erased at build). workerd treats every *value* named export of
// the entry as a named entrypoint and rejects non-handler values (strings/arrays/objects)
// at `wrangler dev` boot ("not of type function or ExportedHandler"). Tests import the
// helpers from their own modules (./schema, ./seed, ./service, ./repo/*) directly, so no
// runtime re-export is needed here.
