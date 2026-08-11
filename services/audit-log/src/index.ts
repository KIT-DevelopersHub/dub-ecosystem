// audit-log Worker entry: HTTP (fetch), Queue consumer (dub-q-audit-record),
// scheduled Cron (monthly R2 archive). Deploy is out of scope for this unit.
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import { createApp } from "./app";
import { consumeAuditQueue } from "./queue";
import { archiveOldRecords } from "./archive";
import { SERVICE_NAME } from "./config";
import type { Env } from "./env";

const app = createApp();

// Plain module handler (not typed as ExportedHandler to avoid the workers-types vs
// undici Response brand clash under the root tsconfig which omits workers-types globals).
const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },

  queue(batch: MessageBatch<AuditRecordEnvelopeV1>, env: Env): Promise<void> {
    return consumeAuditQueue(batch, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Free-tier (wrangler.free.toml) binds no R2: skip the archive, leave ingestion intact.
    if (!env.AUDIT_ARCHIVE) {
      consoleSink({ level: "info", message: "audit archive skipped (no R2 binding)", service: SERVICE_NAME, fields: {} });
      return;
    }
    const db = createDbClient(env.DB, { namespace: "audit" });
    const summary = await archiveOldRecords(db, env.AUDIT_ARCHIVE);
    consoleSink({ level: "info", message: "audit archive job finished", service: SERVICE_NAME, fields: { ...summary } });
  },
};

export default handler;
export { createApp };
export type { Env };
