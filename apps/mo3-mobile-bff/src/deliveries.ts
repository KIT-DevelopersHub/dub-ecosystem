// Push delivery records — MO3-owned data (mobile_push_deliveries). One row per
// (notification, device); status tracks the send lifecycle for the audit trail.
import { type DbClient, newId, nowIso } from "@dub/db";

export type DeliveryStatus = "queued" | "sent" | "failed" | "token_invalid";

export interface DeliveryStore {
  /** Create a queued delivery row; returns its id. Idempotent on (notificationId, deviceId). */
  createQueued(notificationId: string, deviceId: string): Promise<string>;
  markStatus(id: string, status: DeliveryStatus, attempts: number, lastError?: string | null): Promise<void>;
}

export class D1DeliveryStore implements DeliveryStore {
  constructor(private readonly db: DbClient) {}

  async createQueued(notificationId: string, deviceId: string): Promise<string> {
    const id = newId("mdlv");
    const now = nowIso();
    // ON CONFLICT keeps the first row (idempotent redelivery of the same notification).
    await this.db.run(
      "INSERT INTO mobile_push_deliveries (id, notification_id, device_id, status, attempts, last_error, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'queued', 0, NULL, ?, ?) " +
        "ON CONFLICT (notification_id, device_id) DO NOTHING",
      id,
      notificationId,
      deviceId,
      now,
      now,
    );
    const row = await this.db.first<{ id: string }>(
      "SELECT id FROM mobile_push_deliveries WHERE notification_id = ? AND device_id = ?",
      notificationId,
      deviceId,
    );
    return row?.id ?? id;
  }

  async markStatus(id: string, status: DeliveryStatus, attempts: number, lastError?: string | null): Promise<void> {
    await this.db.run(
      "UPDATE mobile_push_deliveries SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
      status,
      attempts,
      lastError ?? null,
      nowIso(),
      id,
    );
  }
}
