import { describe, it, expect } from "vitest";
import type { DbClient, DbRunResult, DbStatement } from "@dub/db";
import { D1MutationStore } from "../src/mutation-store";
import { D1ChangeLogReader } from "../src/change-log";
import type { MutationResult } from "../src/mutations";
import { ALICE } from "./helpers";

// Configurable fake D1: records statements, replays a scripted first()/all() result.
class RecordingDb implements DbClient {
  readonly namespace = "mobile" as const;
  reads: { sql: string; binds: unknown[] }[] = [];
  writes: { sql: string; binds: unknown[] }[] = [];
  firstResult: unknown = null;
  allResult: unknown[] = [];

  async first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    this.reads.push({ sql, binds });
    return this.firstResult as T | null;
  }
  async all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    this.reads.push({ sql, binds });
    return this.allResult as T[];
  }
  async run(sql: string, ...binds: unknown[]): Promise<DbRunResult> {
    this.writes.push({ sql, binds });
    return { success: true, meta: { changes: 1, durationMs: 0 } };
  }
  async batch(_stmts: readonly DbStatement[]): Promise<DbRunResult[]> {
    return [];
  }
  raw(): never {
    throw new Error("not used");
  }
}

describe("D1MutationStore", () => {
  it("save() inserts an applied result with ON CONFLICT idempotency", async () => {
    const db = new RecordingDb();
    const result: MutationResult = { idempotencyKey: "k1", status: "applied", resource: { id: "tsk_1", version: 2 } };
    await new D1MutationStore(db).save({ idempotencyKey: "k1", userId: ALICE, op: "task.update", result });

    expect(db.writes).toHaveLength(1);
    const { sql, binds } = db.writes[0]!;
    expect(sql).toContain("INSERT INTO mobile_mutations");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    // (id, user_id, kind, status, result_json, created_at, updated_at) — device_id/payload_json are literals
    expect(binds[0]).toBe("k1");
    expect(binds[1]).toBe(ALICE);
    expect(binds[2]).toBe("task.update");
    expect(binds[3]).toBe("applied");
    expect(JSON.parse(binds[4] as string)).toMatchObject({ status: "applied", resource: { id: "tsk_1" } });
    expect(binds).toHaveLength(7);
  });

  it("save() maps a conflict result to status 'rejected'", async () => {
    const db = new RecordingDb();
    const result: MutationResult = { idempotencyKey: "k2", status: "conflict", error: { code: "TASK_VERSION_CONFLICT", message: "x" } };
    await new D1MutationStore(db).save({ idempotencyKey: "k2", userId: ALICE, op: "task.update", result });
    expect(db.writes[0]!.binds[3]).toBe("rejected");
  });

  it("get() parses result_json back into the prior result", async () => {
    const db = new RecordingDb();
    db.firstResult = { result_json: JSON.stringify({ idempotencyKey: "k3", status: "applied", resource: 1 }) };
    const got = await new D1MutationStore(db).get("k3");
    expect(got).toMatchObject({ idempotencyKey: "k3", status: "applied" });
    expect(db.reads[0]!.sql).toContain("SELECT result_json FROM mobile_mutations WHERE id = ?");
  });

  it("get() returns null for an absent row and for corrupt JSON", async () => {
    const db = new RecordingDb();
    db.firstResult = null;
    expect(await new D1MutationStore(db).get("missing")).toBeNull();
    db.firstResult = { result_json: "{not json" };
    expect(await new D1MutationStore(db).get("corrupt")).toBeNull();
  });
});

describe("D1ChangeLogReader", () => {
  it("headSeq() returns MAX(seq), defaulting to 0 when empty/null", async () => {
    const db = new RecordingDb();
    db.firstResult = { seq: 7 };
    expect(await new D1ChangeLogReader(db).headSeq()).toBe(7);
    expect(db.reads[0]!.sql).toContain("SELECT MAX(seq) AS seq FROM mobile_change_log");
    db.firstResult = { seq: null };
    expect(await new D1ChangeLogReader(db).headSeq()).toBe(0);
    db.firstResult = null;
    expect(await new D1ChangeLogReader(db).headSeq()).toBe(0);
  });

  it("deletesSince() short-circuits an empty window without hitting D1", async () => {
    const db = new RecordingDb();
    expect(await new D1ChangeLogReader(db).deletesSince(5, 5)).toEqual([]);
    expect(await new D1ChangeLogReader(db).deletesSince(9, 3)).toEqual([]);
    expect(db.reads).toHaveLength(0);
  });

  it("deletesSince() queries only delete rows in (afterSeq, upToSeq] and maps them", async () => {
    const db = new RecordingDb();
    db.allResult = [
      { seq: 2, entity_type: "task", entity_id: "t1" },
      { seq: 3, entity_type: "event", entity_id: "e1" },
    ];
    const out = await new D1ChangeLogReader(db).deletesSince(1, 3);
    expect(out).toEqual([
      { seq: 2, entityType: "task", entityId: "t1" },
      { seq: 3, entityType: "event", entityId: "e1" },
    ]);
    const { sql, binds } = db.reads[0]!;
    expect(sql).toContain("op = 'delete'");
    expect(sql).toContain("seq > ? AND seq <= ?");
    expect(binds).toEqual([1, 3]);
  });
});
