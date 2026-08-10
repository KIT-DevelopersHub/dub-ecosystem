// Self-apply migration for the drive-proxy watch-channel registry (mirrors
// 0001_init.sql). drive-proxy owns operational channel state only; it is NOT a
// registered @dub/db schema namespace (file-meta owns Drive metadata), so this
// migration is intentionally self-contained rather than a @dub/db `Migration`
// (whose `namespace` is a closed union). infra #28 remains the physical owner; this
// export lets the unit self-apply in local/preview and tests via applyDriveMigrations.
import type { D1Database } from "@cloudflare/workers-types";

export interface DriveMigration {
  id: string;
  up: string;
}

export const migration0001Init: DriveMigration = {
  id: "0001_init",
  up: `
CREATE TABLE drive_watch_channels (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  token_version TEXT NOT NULL CHECK (token_version IN ('current','next')),
  address       TEXT NOT NULL,
  expiration    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active','stopped')),
  actor_id      TEXT,
  request_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (channel_id)
);
CREATE INDEX idx_drive_watch_channels_file ON drive_watch_channels (file_id, status);
CREATE INDEX idx_drive_watch_channels_status_exp ON drive_watch_channels (status, expiration);
`.trim(),
};

export const DRIVE_MIGRATIONS: readonly DriveMigration[] = [migration0001Init];

function splitStatements(up: string): string[] {
  return up
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Forward-only, best-effort self-apply (local/preview/tests). Idempotent via IF NOT EXISTS-free
 *  DDL guarded by a caller who runs it once; production DDL is owned by infra #28. */
export async function applyDriveMigrations(d1: D1Database): Promise<void> {
  for (const m of DRIVE_MIGRATIONS) {
    for (const stmt of splitStatements(m.up)) {
      await d1.prepare(stmt).run();
    }
  }
}
