// Dependency seam: the Hono app + Queue/cron handlers are built from this bag so
// tests can inject in-memory fakes (repo, publisher, auditor, authorizer, upstream
// clients, idempotency store) without any Cloudflare runtime.
import { createDbClient } from "@dub/db";
import type { IdempotencyStore } from "@dub/events";
import { configFromEnv, type AppConfig, type Env } from "./env";
import { createD1TaskRepo, type TaskRepo } from "./repo";
import {
  createServiceBindingEventClient,
  createServiceBindingIdentityClient,
  createIdentityAuthorizer,
  type EventClient,
  type IdentityClient,
  type Authorizer,
} from "./clients";
import {
  createQueueEventPublisher,
  createQueueAuditor,
  buildPublisherEnv,
  buildAuditEnv,
  type EventPublisher,
  type Auditor,
} from "./events";
import { createD1IdempotencyStore } from "./idempotency";

export interface Deps {
  config: AppConfig;
  repo: TaskRepo;
  events: EventPublisher;
  audit: Auditor;
  authz: Authorizer;
  eventClient: EventClient;
  identity: IdentityClient;
  idempotency: IdempotencyStore;
}

/** Wire production dependencies from Worker bindings (rebuilt per request/batch). */
export function buildDeps(env: Env): Deps {
  const config = configFromEnv(env);
  const db = createDbClient(env.DB, { namespace: "task" });
  return {
    config,
    repo: createD1TaskRepo(db),
    events: createQueueEventPublisher(buildPublisherEnv(env)),
    audit: createQueueAuditor(buildAuditEnv(env)),
    authz: createIdentityAuthorizer(env.SVC_IDENTITY, config.orgId),
    eventClient: createServiceBindingEventClient(env.SVC_EVENT),
    identity: createServiceBindingIdentityClient(env.SVC_IDENTITY),
    idempotency: createD1IdempotencyStore(db),
  };
}
