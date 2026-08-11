// Assemble per-request dependencies from Worker bindings. Shared by the HTTP app
// (POST /send), the inbound email() handler and the cron so every lane uses the same
// namespace-scoped DB client, provider and publish targets.
import { createDbClient, type DbClient } from "@dub/db";
import { common } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { Env } from "./env";
import { DEFAULT_FROM_ADDRESS } from "./config";
import { buildProvider, type MailProvider } from "./provider";
import { sendRetryOptions } from "./resilience";
import { AUDIT_TOPIC, TOPIC_MAIL_AUTOMATION, TOPIC_NOTIFICATION, outboxQueue } from "./outbox";
import type { AuditEnv, EventPublishEnv, InboundDeps, SendDeps } from "./types";

export function buildDb(env: Env, requestId: string): DbClient {
  return createDbClient(env.DB, { namespace: "mail", requestId });
}

// Prefer a real (paid) Queue binding when present; otherwise fall back to the free-tier
// @dub/freeq D1 outbox shim so audit/event records are durably persisted, never dropped.
function eventEnv(env: Env): EventPublishEnv {
  return {
    EVT_MAIL_AUTOMATION: env.EVT_MAIL_AUTOMATION ?? outboxQueue(env.DB, TOPIC_MAIL_AUTOMATION),
    EVT_NOTIFICATION: env.EVT_NOTIFICATION ?? outboxQueue(env.DB, TOPIC_NOTIFICATION),
  };
}
export function buildAuditEnv(env: Env): AuditEnv {
  return { AUDIT_QUEUE: env.AUDIT_QUEUE ?? outboxQueue(env.DB, AUDIT_TOPIC) };
}

export function buildSendDeps(env: Env, ctx: RequestContext, provider: MailProvider = buildProvider(env)): SendDeps {
  return {
    db: buildDb(env, ctx.requestId),
    provider,
    events: eventEnv(env),
    audit: buildAuditEnv(env),
    orgId: common.DUB_DEFAULT_ORG_ID,
    fromAddress: env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS,
    ctx,
    retry: sendRetryOptions(env),
  };
}

export function buildInboundDeps(env: Env, ctx: RequestContext): InboundDeps {
  return {
    db: buildDb(env, ctx.requestId),
    events: eventEnv(env),
    audit: buildAuditEnv(env),
    orgId: common.DUB_DEFAULT_ORG_ID,
    ctx,
  };
}
