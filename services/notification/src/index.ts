// notification Worker entry: HTTP (fetch), Queue consumer (dub-q-evt-notification),
// scheduled Cron (daily retention purge). Deploy is out of scope for this unit.
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { consumeEventQueue } from "./queue";
import { runRetentionPurge } from "./scheduled";
import { runAuditDrain } from "./drain";
import { SERVICE_NAME } from "./config";
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

  // Daily Cron: retention purge + free-tier audit outbox drain. On the paid deploy
  // OUTBOX_DB/SVC_AUDIT are absent so the drain is a no-op (the real Queue + Queue
  // consumer carry the audit fan-out instead); on the free deploy it forwards
  // durably-persisted delivery-failed audit records to audit-log.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runRetentionPurge(env);
    const drained = await runAuditDrain(env);
    consoleSink({ level: "info", message: "notification audit outbox drained", service: SERVICE_NAME, fields: { ...drained } });
  },
};

export default handler;
export { createApp };
export type { Env };
