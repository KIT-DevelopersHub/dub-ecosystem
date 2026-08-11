// freeq-drain Worker entry. The single aggregated drain of every bound @dub/freeq outbox
// D1 is driven by a Durable Object ALARM (see src/drain-do.ts), NOT a Cron Trigger — the
// Workers Free plan's 5-cron account cap is full of business crons, and a DO alarm does not
// count against it. This is the ONLY drainer of the freeq outboxes: the per-service drains
// were neutralized so no two workers claim the shared dub-core table (the mis-ack data-loss
// bug). fetch() serves the health probe AND the POST /internal/drain/kick bootstrap that
// arms the DO alarm once after deploy (see app.ts).
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";

export { FreeqDrainDO } from "./drain-do";

const app = createApp();

// Plain module handler (not typed as ExportedHandler to avoid the workers-types vs undici
// Response brand clash under the root tsconfig which omits workers-types globals).
const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },
};

export default handler;
export { createApp };
export type { Env };
