// freeq-drain Worker entry. ONE cron (see wrangler.toml [triggers] crons = ["*/5 * * * *"])
// drives a single aggregated drain of every bound @dub/freeq outbox D1. This is the ONLY
// drainer of the freeq outboxes: the per-service drains were neutralized so no two workers
// claim the shared dub-core table (which caused the mis-ack data-loss bug). fetch() is a
// trivial health probe (a Worker needs a default export with a fetch handler).
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { drainAll } from "./drain-all";
import type { Env } from "./env";

const app = createApp();

// Plain module handler (not typed as ExportedHandler to avoid the workers-types vs undici
// Response brand clash under the root tsconfig which omits workers-types globals).
const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const results = await drainAll(env);
    consoleSink({ level: "info", message: "freeq aggregated drain", service: "freeq-drain", fields: { ...results } });
  },
};

export default handler;
export { createApp };
export type { Env };
