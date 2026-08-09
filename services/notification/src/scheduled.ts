// Daily retention purge (design §3): inbox 90d / deliveries 30d / processed 7d.
import { createDbClient } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { Env } from "./env";
import {
  SERVICE_NAME,
  INBOX_RETENTION_DAYS,
  DELIVERIES_RETENTION_DAYS,
  PROCESSED_EVENTS_RETENTION_DAYS,
} from "./config";
import { purgeOlderThan } from "./repo";

function cutoff(days: number, now: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function runRetentionPurge(env: Env, now: number = Date.now()): Promise<{ inbox: number; deliveries: number; processed: number }> {
  const db = createDbClient(env.DB, { namespace: "notif" });
  const summary = await purgeOlderThan(
    db,
    cutoff(INBOX_RETENTION_DAYS, now),
    cutoff(DELIVERIES_RETENTION_DAYS, now),
    cutoff(PROCESSED_EVENTS_RETENTION_DAYS, now),
  );
  consoleSink({ level: "info", message: "notification retention purge finished", service: SERVICE_NAME, fields: { ...summary } });
  return summary;
}
