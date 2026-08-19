// app-health-monitor Worker entry. Hourly死活監視 is driven by a Durable Object ALARM (see
// monitor-do.ts), NOT a Cron Trigger — the Workers Free plan's 5-cron account cap is full of
// business crons and a DO alarm does not count against it. fetch() serves the liveness probe,
// the POST /internal/monitor/kick bootstrap that arms the alarm after deploy, the POST
// /internal/monitor/run on-demand cycle, and the GET /internal/monitor/status snapshot.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";

export { MonitorDO } from "./monitor-do";

const app = createApp();

const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },
};

export default handler;
export { createApp };
export type { Env };
