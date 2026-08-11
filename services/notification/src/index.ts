// notification Worker entry: HTTP (fetch), Queue consumer (dub-q-evt-notification),
// scheduled Cron (daily retention purge). Deploy is out of scope for this unit.
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { createApp } from "./app";
import { consumeEventQueue } from "./queue";
import { runRetentionPurge } from "./scheduled";
import type { Env } from "./env";

const app = createApp();

// Plain module handler (not typed as ExportedHandler to avoid the workers-types vs
// undici Response brand clash under the root tsconfig which omits workers-types globals).
const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },

  queue(batch: MessageBatch<DubEventEnvelope>, env: Env): Promise<void> {
    return consumeEventQueue(batch, env);
  },

  // Daily Cron: retention purge only. The free-tier audit outbox drain was REMOVED from
  // here — the freeq outbox is now drained centrally by the standalone freeq-drain worker
  // (single aggregated cron). This service keeps its own business cron (retention purge).
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runRetentionPurge(env);
  },
};

export default handler;
export { createApp };
export type { Env };
