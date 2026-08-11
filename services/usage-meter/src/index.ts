// usage-meter Worker entry. Daily free-tier usage collection is driven by a Durable Object
// ALARM (see meter-do.ts), NOT a Cron Trigger — the Workers Free plan's 5-cron account cap
// is full of business crons and a DO alarm does not count against it. fetch() serves the
// health probe, the POST /internal/meter/kick bootstrap that arms the alarm after deploy,
// the POST /internal/meter/refresh on-demand recollect, and the GET /usage/summary read.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";

export { MeterDO } from "./meter-do";

const app = createApp();

const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },
};

export default handler;
export { createApp };
export type { Env };
