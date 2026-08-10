import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createWatchChannelRepo, type WatchChannelRecord } from "../src/watch/repo";

// Recording D1: captures (sql, binds) per prepared statement and returns a canned
// result queued by the test. Proves the repo issues real, correctly-bound SQL and maps
// snake_case rows back to the record shape — without a SQLite engine (repo-wide precedent).
interface Exec { sql: string; binds: unknown[] }
function recordingD1(): {
  db: D1Database;
  execs: Exec[];
  queueFirst: (row: unknown) => void;
  queueAll: (rows: unknown[]) => void;
  queueRun: (changes: number) => void;
} {
  const execs: Exec[] = [];
  const firsts: unknown[] = [];
  const alls: unknown[][] = [];
  const runs: number[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...b: unknown[]) { this.binds = b; execs.push({ sql, binds: b }); return this; },
        async first<T>() { return (firsts.length ? firsts.shift() : null) as T | null; },
        async all<T>() { return { results: (alls.length ? alls.shift() : []) as T[], success: true, meta: {} }; },
        async run() { return { success: true, meta: { changes: runs.length ? runs.shift()! : 0 } }; },
      };
      // support prepare(sql).run()/all() with no bind() (none of our repo paths do, but be safe)
      return stmt as unknown as ReturnType<D1Database["prepare"]>;
    },
  } as unknown as D1Database;
  return {
    db,
    execs,
    queueFirst: (row) => firsts.push(row),
    queueAll: (rows) => alls.push(rows),
    queueRun: (changes) => runs.push(changes),
  };
}

const REC: WatchChannelRecord = {
  id: "dwc_1",
  channelId: "chan-1",
  resourceId: "RID-1",
  fileId: "folder_1",
  tokenVersion: "current",
  address: "https://cb",
  expiration: "2026-08-10T00:00:00.000Z",
  status: "active",
  actorId: "usr_1",
  requestId: "req_1",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

const ROW = {
  id: "dwc_1",
  channel_id: "chan-1",
  resource_id: "RID-1",
  file_id: "folder_1",
  token_version: "current",
  address: "https://cb",
  expiration: "2026-08-10T00:00:00.000Z",
  status: "active",
  actor_id: "usr_1",
  request_id: "req_1",
  created_at: "2026-08-09T00:00:00.000Z",
  updated_at: "2026-08-09T00:00:00.000Z",
};

describe("createWatchChannelRepo (D1 wiring)", () => {
  it("insert binds all 12 columns in DDL order", async () => {
    const d = recordingD1();
    d.queueRun(1);
    await createWatchChannelRepo(d.db).insert(REC);
    const exec = d.execs[0]!;
    expect(exec.sql).toContain("INSERT INTO drive_watch_channels");
    expect(exec.binds).toEqual([
      "dwc_1", "chan-1", "RID-1", "folder_1", "current", "https://cb",
      "2026-08-10T00:00:00.000Z", "active", "usr_1", "req_1",
      "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z",
    ]);
  });

  it("getByChannelId maps a snake_case row back to the record", async () => {
    const d = recordingD1();
    d.queueFirst(ROW);
    const out = await createWatchChannelRepo(d.db).getByChannelId("chan-1");
    expect(out).toEqual(REC);
    expect(d.execs[0]!.sql).toContain("WHERE channel_id = ?");
    expect(d.execs[0]!.binds).toEqual(["chan-1"]);
  });

  it("getByChannelId returns null when no row matches", async () => {
    const d = recordingD1();
    const out = await createWatchChannelRepo(d.db).getByChannelId("nope");
    expect(out).toBeNull();
  });

  it("getActiveByFileId filters status=active newest-first", async () => {
    const d = recordingD1();
    d.queueFirst(ROW);
    await createWatchChannelRepo(d.db).getActiveByFileId("folder_1");
    expect(d.execs[0]!.sql).toContain("status = 'active'");
    expect(d.execs[0]!.sql).toContain("ORDER BY created_at DESC");
    expect(d.execs[0]!.binds).toEqual(["folder_1"]);
  });

  it("markStopped only transitions active rows and reports whether a row changed", async () => {
    const d = recordingD1();
    d.queueRun(1);
    const changed = await createWatchChannelRepo(d.db).markStopped("chan-1", "2026-08-10T01:00:00.000Z");
    expect(changed).toBe(true);
    expect(d.execs[0]!.sql).toContain("SET status = 'stopped'");
    expect(d.execs[0]!.sql).toContain("WHERE channel_id = ? AND status = 'active'");
    expect(d.execs[0]!.binds).toEqual(["2026-08-10T01:00:00.000Z", "chan-1"]);

    const d2 = recordingD1();
    d2.queueRun(0); // already stopped -> no row changed
    expect(await createWatchChannelRepo(d2.db).markStopped("chan-1", "t")).toBe(false);
  });

  it("listExpiringBefore selects active, non-null expiration <= cutoff", async () => {
    const d = recordingD1();
    d.queueAll([ROW]);
    const out = await createWatchChannelRepo(d.db).listExpiringBefore("2026-08-11T00:00:00.000Z");
    expect(out).toEqual([REC]);
    expect(d.execs[0]!.sql).toContain("expiration IS NOT NULL AND expiration <= ?");
    expect(d.execs[0]!.binds).toEqual(["2026-08-11T00:00:00.000Z"]);
  });
});
