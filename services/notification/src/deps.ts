// Assemble the per-request delivery dependencies from Worker bindings. Shared by the
// HTTP app (POST /notify) and the queue consumer so both lanes deliver identically
// (design test #11 — lane B/C equivalence).
import { createDbClient, type DbClient } from "@dub/db";
import { common } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { Env } from "./env";
import {
  makeChatPort,
  makeEventPort,
  makeIdentityPort,
  makeMailPort,
  makePushPort,
  type IdentityPort,
} from "./clients";
import {
  makeChatAdapter,
  makeEmailAdapter,
  makeInAppAdapter,
  makePushAdapter,
  type AdapterRegistry,
} from "./adapters";
import { makeRecipientResolver } from "./recipients";
import { resolveAuditQueue } from "./outbox";
import type { IngestDeps } from "./ingest";

export function buildDb(env: Env, requestId: string): DbClient {
  return createDbClient(env.DB, { namespace: "notif", requestId });
}

export function buildAdapters(env: Env, db: DbClient, identity: IdentityPort, ctx: RequestContext): AdapterRegistry {
  return {
    in_app: makeInAppAdapter(db),
    email: makeEmailAdapter({
      ...(env.SVC_MAIL_GATEWAY ? { mail: makeMailPort(env.SVC_MAIL_GATEWAY) } : {}),
      identity,
      ctx,
    }),
    chat: makeChatAdapter({ ...(env.SVC_CHAT ? { chat: makeChatPort(env.SVC_CHAT) } : {}), ctx }),
    push: makePushAdapter({ ...(env.SVC_MOBILE_BFF ? { push: makePushPort(env.SVC_MOBILE_BFF) } : {}), ctx }),
  };
}

/** Full ingest dependency bundle for one request/message. */
export function buildIngestDeps(env: Env, ctx: RequestContext): IngestDeps {
  const db = buildDb(env, ctx.requestId);
  const identity = makeIdentityPort(env.SVC_IDENTITY);
  const event = makeEventPort(env.SVC_EVENT);
  const resolver = makeRecipientResolver({ identity, event });
  const adapters = buildAdapters(env, db, identity, ctx);
  return {
    db,
    resolver,
    adapters,
    // Paid Queue when bound; else free-tier @dub/freeq outbox shim; else null (no sink →
    // publish is skipped, never dropped-with-a-throw). See outbox.ts / env.ts.
    auditEnv: resolveAuditQueue(env),
    orgId: common.DUB_DEFAULT_ORG_ID,
    ctx,
  };
}
