// Daily retention purge (design §3): send_log 30d / inbound 30d. Same window as the
// webhook-ingest / notification retention运用.
import { createDbClient } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { Env } from "./env";
import { SEND_LOG_RETENTION_DAYS, INBOUND_RETENTION_DAYS, SERVICE_NAME } from "./config";
import { purgeOlderThan } from "./repo";

function cutoff(days: number, now: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function runRetentionPurge(env: Env, now: number = Date.now()): Promise<{ sendLog: number; inbound: number }> {
  const db = createDbClient(env.DB, { namespace: "mail" });
  const summary = await purgeOlderThan(db, cutoff(SEND_LOG_RETENTION_DAYS, now), cutoff(INBOUND_RETENTION_DAYS, now));
  consoleSink({ level: "info", message: "mail-gateway retention purge finished", service: SERVICE_NAME, fields: { ...summary } });
  return summary;
}
