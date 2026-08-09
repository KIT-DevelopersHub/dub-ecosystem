// Consumer idempotency over the task_idempotency ledger (envelope.id dedup).
import type { DbClient } from "@dub/db";
import type { IdempotencyStore } from "@dub/events";

export function createD1IdempotencyStore(db: DbClient): IdempotencyStore {
  return {
    async wasProcessed(eventId: string): Promise<boolean> {
      const row = await db.first<{ envelope_id: string }>(
        `SELECT envelope_id FROM task_idempotency WHERE envelope_id = ?`,
        eventId,
      );
      return row !== null;
    },
    async markProcessed(eventId: string): Promise<void> {
      await db.run(
        `INSERT OR IGNORE INTO task_idempotency (envelope_id, processed_at) VALUES (?, ?)`,
        eventId,
        new Date().toISOString(),
      );
    },
  };
}
