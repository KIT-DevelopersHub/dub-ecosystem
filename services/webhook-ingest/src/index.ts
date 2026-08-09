// webhook-ingest Worker entry: HTTP ingress (fetch) + daily retention sweep (scheduled).
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { cleanup } from "./cleanup";
import { createDeliveryRepo } from "./repo";
import { DEFAULT_RETENTION_DAYS, type Env } from "./env";

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const repo = createDeliveryRepo(createDbClient(env.DUB_DB, { namespace: "webhook" }));
    const retentionDays = env.RETENTION_DAYS ? Number.parseInt(env.RETENTION_DAYS, 10) : DEFAULT_RETENTION_DAYS;
    const days = Number.isNaN(retentionDays) ? DEFAULT_RETENTION_DAYS : retentionDays;
    const run = cleanup({ repo, raw: env.WEBHOOK_RAW }, days).then((res) => {
      consoleSink({ level: "info", message: "webhook retention sweep", service: "webhook-ingest", fields: { ...res, retentionDays: days } });
    });
    ctx.waitUntil(run);
    await run;
  },
};
