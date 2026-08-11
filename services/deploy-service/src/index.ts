// Worker entrypoint. HTTP via Hono; the private deploy-jobs queue via handleDeployJobs
// (paid plan); the free-tier @dub/freeq outbox drain via the Cron scheduled handler.
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { handleDeployJobs } from "./queue";
import { runOutboxDrain } from "./drain";
import { SERVICE_NAME } from "./deps";
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
  // FREE plan: Cron drains the freeq outbox (forwards audit rows to audit-log, runs deploy
  // jobs in process, defers domain events). Best-effort — a drain hiccup only logs.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const result = await runOutboxDrain(env);
      consoleSink({ level: "info", message: "deploy-service outbox drained", service: SERVICE_NAME, fields: { ...result } });
    } catch (err) {
      consoleSink({
        level: "error",
        message: "deploy-service outbox drain failed",
        service: SERVICE_NAME,
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  },
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
