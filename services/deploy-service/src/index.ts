// Worker entrypoint. HTTP via Hono; the private deploy-jobs queue via handleDeployJobs.
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
  async queue(batch: MessageBatch<DeployJobMessage>, env: Env): Promise<void> {
    await handleDeployJobs(batch, env);
  },
};

export { createApp } from "./app";
export { handleDeployJobs } from "./queue";
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
