// Daily retention purge (design §3): send_log 30d / inbound 30d. Same window as the
// webhook-ingest / notification retention运用.
import { createDbClient } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { Env } from "./env";
import { SEND_LOG_RETENTION_DAYS, INBOUND_RETENTION_DAYS, SERVICE_NAME } from "./config";
import { attachmentKeysOlderThan, purgeOlderThan } from "./repo";
import { r2Blobs } from "./attachments";

function cutoff(days: number, now: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function runRetentionPurge(env: Env, now: number = Date.now()): Promise<{ sendLog: number; inbound: number; attachments: number }> {
  const db = createDbClient(env.DB, { namespace: "mail" });
  const sendCutoff = cutoff(SEND_LOG_RETENTION_DAYS, now);
  const inboundCutoff = cutoff(INBOUND_RETENTION_DAYS, now);
  // Collect the R2 keys BEFORE deleting the metadata rows so we can free the bytes too.
  const keys = env.R2_MAIL ? await attachmentKeysOlderThan(db, sendCutoff, inboundCutoff) : [];
  const summary = await purgeOlderThan(db, sendCutoff, inboundCutoff);
  if (env.R2_MAIL && keys.length > 0) {
    const blobs = r2Blobs(env.R2_MAIL);
    for (const key of keys) {
      try {
        await blobs.delete(key);
      } catch (err) {
        consoleSink({ level: "error", message: "mail-gateway: failed to purge attachment blob", service: SERVICE_NAME, fields: { key, error: err instanceof Error ? err.message : String(err) } });
      }
    }
  }
  consoleSink({ level: "info", message: "mail-gateway retention purge finished", service: SERVICE_NAME, fields: { ...summary } });
  return summary;
}
