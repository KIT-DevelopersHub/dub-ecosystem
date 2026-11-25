// Counts Calendar / Meet calls per UTC minute for the 無料枠 dashboard (usage-meter reads the
// table). Best-effort: a failed count is logged and must never fail the Google call it measures.
import { createDbClient } from "@dub/db";
import type { D1Database } from "@cloudflare/workers-types";

export type MeteredGoogleApi = "calendar" | "meet";
export type GoogleCallRecorder = (api: MeteredGoogleApi) => Promise<void>;

export function createGoogleCallRecorder(d1: D1Database, now: () => Date = () => new Date()): GoogleCallRecorder {
  return async (api) => {
    try {
      await createDbClient(d1, { namespace: "driveshare" }).run(
        `INSERT INTO driveshare_google_api_usage (api, minute, calls) VALUES (?, ?, 1)
         ON CONFLICT (api, minute) DO UPDATE SET calls = calls + 1`,
        api,
        now().toISOString().slice(0, 16),
      );
    } catch (cause) {
      console.warn(JSON.stringify({ service: "drive-share-service", event: "google_call_count_failed", api, message: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
}
