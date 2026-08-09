// Device registry — MO3-owned data (mobile_devices). Push-token upsert is
// idempotent on (platform, push_token): re-registration by the same user refreshes
// last_seen; registration by a different user (device hand-off) reassigns the row
// and stops push to the previous user (design §7 tests #1/#2).
import type { mobile } from "@dub/types";
import { type DbClient, newId, nowIso } from "@dub/db";

export interface DeviceRecord {
  id: string; // server-minted ULID ("mdev_...")
  userId: string;
  platform: mobile.MobilePlatform;
  pushToken: string;
  appVersion: string | null;
  locale: string | null;
  disabledAt: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export interface UpsertDeviceInput {
  userId: string;
  platform: mobile.MobilePlatform;
  pushToken: string;
  appVersion?: string | null;
  locale?: string | null;
}

export interface UpsertDeviceResult {
  device: DeviceRecord;
  replacedExisting: boolean; // true when an existing (platform, pushToken) row was re-owned
}

export interface DeviceStore {
  upsertByToken(input: UpsertDeviceInput): Promise<UpsertDeviceResult>;
  listActiveByUser(userId: string): Promise<DeviceRecord[]>;
  getById(id: string): Promise<DeviceRecord | null>;
  /** Disable the caller's own device (logout). Returns false if not found/not owner. */
  disableOwned(userId: string, id: string): Promise<boolean>;
  /** Disable a device after the provider reports its token invalid (auto-cleanup). */
  disableById(id: string): Promise<void>;
}

/** Maps a stored row to the frozen wire DTO (id/platform/registeredAt only). */
export function toDeviceDto(rec: DeviceRecord): mobile.DeviceDto {
  return { id: rec.id, platform: rec.platform, registeredAt: rec.createdAt };
}

interface DeviceRow {
  id: string;
  user_id: string;
  platform: string;
  push_token: string;
  app_version: string | null;
  locale: string | null;
  disabled_at: string | null;
  last_seen_at: string;
  created_at: string;
}

function rowToRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform as mobile.MobilePlatform,
    pushToken: row.push_token,
    appVersion: row.app_version,
    locale: row.locale,
    disabledAt: row.disabled_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

/** D1-backed store (mobile namespace). All statements stay inside mobile_*. */
export class D1DeviceStore implements DeviceStore {
  constructor(private readonly db: DbClient) {}

  async upsertByToken(input: UpsertDeviceInput): Promise<UpsertDeviceResult> {
    const existing = await this.db.first<DeviceRow>(
      "SELECT * FROM mobile_devices WHERE platform = ? AND push_token = ?",
      input.platform,
      input.pushToken,
    );
    const now = nowIso();
    if (existing) {
      const replacedExisting = existing.user_id !== input.userId;
      await this.db.run(
        "UPDATE mobile_devices SET user_id = ?, app_version = ?, locale = ?, disabled_at = NULL, last_seen_at = ? WHERE id = ?",
        input.userId,
        input.appVersion ?? existing.app_version,
        input.locale ?? existing.locale,
        now,
        existing.id,
      );
      const updated = await this.db.first<DeviceRow>("SELECT * FROM mobile_devices WHERE id = ?", existing.id);
      return { device: rowToRecord(updated ?? existing), replacedExisting };
    }
    const id = newId("mdev");
    await this.db.run(
      "INSERT INTO mobile_devices (id, user_id, platform, push_token, app_version, locale, disabled_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      id,
      input.userId,
      input.platform,
      input.pushToken,
      input.appVersion ?? null,
      input.locale ?? null,
      now,
      now,
    );
    return {
      device: {
        id,
        userId: input.userId,
        platform: input.platform,
        pushToken: input.pushToken,
        appVersion: input.appVersion ?? null,
        locale: input.locale ?? null,
        disabledAt: null,
        lastSeenAt: now,
        createdAt: now,
      },
      replacedExisting: false,
    };
  }

  async listActiveByUser(userId: string): Promise<DeviceRecord[]> {
    const rows = await this.db.all<DeviceRow>(
      "SELECT * FROM mobile_devices WHERE user_id = ? AND disabled_at IS NULL ORDER BY created_at",
      userId,
    );
    return rows.map(rowToRecord);
  }

  async getById(id: string): Promise<DeviceRecord | null> {
    const row = await this.db.first<DeviceRow>("SELECT * FROM mobile_devices WHERE id = ?", id);
    return row ? rowToRecord(row) : null;
  }

  async disableOwned(userId: string, id: string): Promise<boolean> {
    const res = await this.db.run(
      "UPDATE mobile_devices SET disabled_at = ? WHERE id = ? AND user_id = ? AND disabled_at IS NULL",
      nowIso(),
      id,
      userId,
    );
    return res.meta.changes > 0;
  }

  async disableById(id: string): Promise<void> {
    await this.db.run("UPDATE mobile_devices SET disabled_at = ? WHERE id = ?", nowIso(), id);
  }
}
