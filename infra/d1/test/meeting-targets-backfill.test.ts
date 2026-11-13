// driveshare 0006: every meeting made before it gets its single target_id as its first target row,
// the backfill is safe to re-run, and a meeting can still be deleted by a worker that does not know
// the new table (no FK to driveshare_meetings).
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { migratedD1 } from "./d1";

const SQL = readFileSync(new URL("../migrations/driveshare/0006_meeting_targets.sql", import.meta.url), "utf8");
const BACKFILL = SQL.slice(SQL.indexOf("INSERT OR IGNORE"));
const T = "2026-10-01T00:00:00.000Z";

describe("driveshare 0006_meeting_targets", () => {
  it("backfills 'all' and role targets from target_id, idempotently; old-style deletes still work", async () => {
    const { raw } = await migratedD1();
    const insert = raw.prepare(
      `INSERT INTO driveshare_meetings (id, org_id, target_id, account_id, calendar_id, google_event_id, title, starts_at,
         duration_minutes, recurrence, created_by, created_at, updated_at) VALUES (?, 'org_devhub', ?, 'dga', 'cal', 'ev', 't', ?, 60, 'weekly', 'u', ?, ?)`,
    );
    insert.run("dsm_1", "all", T, T, T);
    insert.run("dsm_2", "role_dev", T, T, T);
    raw.exec(BACKFILL);
    raw.exec(BACKFILL);
    const rows = raw.prepare(`SELECT meeting_id, kind, target_id, position FROM driveshare_meeting_targets ORDER BY meeting_id`).all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { meeting_id: "dsm_1", kind: "all", target_id: "all", position: 0 },
      { meeting_id: "dsm_2", kind: "role", target_id: "role_dev", position: 0 },
    ]);
    raw.exec(`DELETE FROM driveshare_meeting_invites WHERE meeting_id = 'dsm_1'; DELETE FROM driveshare_meetings WHERE id = 'dsm_1';`);
    expect(raw.prepare(`SELECT COUNT(*) AS c FROM driveshare_meetings`).get()).toMatchObject({ c: 1 });
  });

  it("refuses an unknown kind", async () => {
    const { raw } = await migratedD1();
    expect(() => raw.exec(`INSERT INTO driveshare_meeting_targets VALUES ('org', 'm', 'team', 'x', 0)`)).toThrow();
  });
});
