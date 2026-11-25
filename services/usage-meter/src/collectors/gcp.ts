// Google API collector — the busiest minute of the last 24h per API, from the per-minute call
// counts drive-share-service keeps (driveshare_google_api_usage). A rolling window so the daily
// collection covers every minute whatever time it runs. No row = no calls = 0; a read failure
// omits the keys (metrics render "unknown"). Never throws.
import { createDbClient, type DbClient } from "@dub/db";
import type { Env } from "../env";
import type { Collector, MetricMap } from "./index";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readGoogleApiPeaks(db: DbClient, now: Date): Promise<MetricMap> {
  const since = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 16);
  const rows = await db.all<{ api: string; peak: number }>(
    "SELECT api, MAX(calls) AS peak FROM driveshare_google_api_usage WHERE minute >= ? GROUP BY api",
    since,
  );
  const peak = (api: string) => rows.find((r) => r.api === api)?.peak ?? 0;
  return { gcp_calendar_requests_peak_minute: peak("calendar"), gcp_meet_requests_peak_minute: peak("meet") };
}

export const gcpCollector: Collector = {
  name: "gcp",
  async collect(env: Env, _mailDb: DbClient, now: Date, log): Promise<MetricMap> {
    if (!env.DB) return {};
    try {
      return await readGoogleApiPeaks(createDbClient(env.DB, { namespace: "driveshare" }), now);
    } catch (err) {
      log?.("google api usage read failed", { error: err instanceof Error ? err.message : String(err) });
      return {};
    }
  },
};
