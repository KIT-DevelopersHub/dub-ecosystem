// Worker entrypoint. HTTP via Hono; the private deploy-jobs queue via handleDeployJobs
// (paid plan); the free-tier @dub/freeq outbox drain via the Cron scheduled handler.
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import { createApp } from "./app";
import { handleDeployJobs } from "./queue";
import type { Env } from "./env";
import type { DeployJobMessage } from "./jobs";

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  // PAID plan: the private deploy-jobs Queue consumer.
  async queue(batch: MessageBatch<DeployJobMessage>, env: Env): Promise<void> {
    await handleDeployJobs(batch, env);
  },
  // NOTE: no scheduled() drain here. The freeq outbox is drained centrally by the
  // standalone freeq-drain worker (single aggregated cron). The `deploy.job` topic has no
  // HTTP landing route (it is processed in-process by deploy-service's own drain/Queue
  // consumer), so freeq-drain DEFERS deploy.job rows — they stay durable/pending. Wiring an
  // internal /internal/deploy-job route is a documented follow-up. src/drain.ts is retained
  // (and re-exported below) as the deliver-contract source for tests and freeq-drain.
};

export { createApp } from "./app";
export { handleDeployJobs, processJob } from "./queue";
export { runOutboxDrain, makeOutboxDeliver } from "./drain";
export { AUDIT_TOPIC, TOPIC_NOTIFICATION, TOPIC_DEPLOY_JOB, outboxQueue, enqueueDeployJob } from "./outbox";
export { buildDeps, SERVICE_NAME } from "./deps";
export type { Deps, DepsFactory } from "./deps";
export { createInMemoryDeployRepo } from "./memory-repo";
export type { InMemoryDeployRepo } from "./memory-repo";
export { createD1DeployRepo } from "./repo";
export type {
  DeployRepo,
  SiteRow,
  DeploymentRow,
  AllowedZoneRow,
  DnsChangeInput,
  ListDeploymentsArgs,
} from "./repo";
export type { CfClient } from "./cf-client";
export type { AuditGateway, IntentInput, ResultInput } from "./audit";
export type { EventBus } from "./events";
export type { DeployJobMessage } from "./jobs";
export type { Env } from "./env";
