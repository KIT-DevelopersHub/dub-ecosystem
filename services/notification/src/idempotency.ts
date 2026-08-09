// D1-backed IdempotencyStore for the domain-event queue consumer. Dedups by
// envelope.id (@dub/events convention: every handler must be idempotent under
// re-delivery). This is INFRASTRUCTURE dedup — distinct from the business dedupKey
// used inside ingest (design §4).
import type { DbClient } from "@dub/db";
import { nowIso } from "@dub/db";
import type { IdempotencyStore } from "@dub/events";

export function makeIdempotencyStore(db: DbClient): IdempotencyStore {
  return {
    async wasProcessed(eventId: string): Promise<boolean> {
      const row = await db.first<{ event_id: string }>(
        `SELECT event_id FROM notif_processed_events WHERE event_id = ?`,
        eventId,
      );
      return row !== null;
    },
    async markProcessed(eventId: string): Promise<void> {
      await db.run(
        `INSERT OR IGNORE INTO notif_processed_events (event_id, processed_at) VALUES (?, ?)`,
        eventId,
        nowIso(),
      );
    },
  };
}
