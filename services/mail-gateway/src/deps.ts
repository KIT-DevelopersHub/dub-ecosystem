// Assemble per-request dependencies from Worker bindings. Shared by the HTTP app
// (POST /send), the inbound email() handler and the cron so every lane uses the same
// namespace-scoped DB client, provider and publish targets.
import { createDbClient, type DbClient } from "@dub/db";
import { common } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { Env } from "./env";
import { DEFAULT_FROM_ADDRESS } from "./config";
import { buildProvider, type MailProvider } from "./provider";
import type { AuditEnv, EventPublishEnv, InboundDeps, SendDeps } from "./types";

export function buildDb(env: Env, requestId: string): DbClient {
  return createDbClient(env.DB, { namespace: "mail", requestId });
}

function eventEnv(env: Env): EventPublishEnv {
  return { EVT_MAIL_AUTOMATION: env.EVT_MAIL_AUTOMATION, EVT_NOTIFICATION: env.EVT_NOTIFICATION };
}
function auditEnv(env: Env): AuditEnv {
  return { AUDIT_QUEUE: env.AUDIT_QUEUE };
}

export function buildSendDeps(env: Env, ctx: RequestContext, provider: MailProvider = buildProvider(env)): SendDeps {
  return {
    db: buildDb(env, ctx.requestId),
    provider,
    events: eventEnv(env),
    audit: auditEnv(env),
    orgId: common.DUB_DEFAULT_ORG_ID,
    fromAddress: env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS,
    ctx,
  };
}

export function buildInboundDeps(env: Env, ctx: RequestContext): InboundDeps {
  return {
    db: buildDb(env, ctx.requestId),
    events: eventEnv(env),
    audit: auditEnv(env),
    orgId: common.DUB_DEFAULT_ORG_ID,
    ctx,
  };
}
