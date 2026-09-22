import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { enqueue, drain, pruneOutbox, backoffMs, type OutboxRow, type OutboxMessage } from "../src/index";
import { makeD1 } from "./d1";

const T0 = Date.parse("2026-08-11T00:00:00.000Z");
const clock = (ms: number) => () => ms;

function allRows(raw: ReturnType<typeof makeD1>["raw"]): OutboxRow[] {
  return raw.prepare("SELECT * FROM freeq_outbox ORDER BY created_at ASC, id ASC").all() as unknown as OutboxRow[];
}
function rowById(raw: ReturnType<typeof makeD1>["raw"], id: string): OutboxRow {
  return raw.prepare("SELECT * FROM freeq_outbox WHERE id = ?").get(id) as unknown as OutboxRow;
}

describe("enqueue (producer INSERT)", () => {
  it("appends a single pending row with the payload JSON-encoded", async () => {
    const { d1, raw } = makeD1();
    const id = await enqueue(d1, "audit.record", { action: "auth.session.login", n: 1 }, { now: clock(T0) });

    const rows = allRows(raw);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.id).toBe(id);
    expect(r.topic).toBe("audit.record");
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(0);
    expect(JSON.parse(r.payload)).toEqual({ action: "auth.session.login", n: 1 });
    expect(r.next_attempt_at).toBe(new Date(T0).toISOString());
    expect(r.created_at).toBe(new Date(T0).toISOString());
    expect(r.last_error).toBeNull();
  });

  it("is idempotent on a supplied id (INSERT OR IGNORE dedupes)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1, "t", { v: 1 }, { id: "fixed-1", now: clock(T0) });
    await enqueue(d1, "t", { v: 2 }, { id: "fixed-1", now: clock(T0 + 5) });

    const rows = allRows(raw);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ v: 1 }); // first write wins
  });
});

describe("drain (claim -> deliver -> done/retry/failed)", () => {
  it("delivers a due pending row and marks it done", async () => {
    const { d1, raw } = makeD1();
    const id = await enqueue(d1, "audit.record", { action: "x" }, { now: clock(T0) });

    const seen: OutboxMessage[] = [];
    const res = await drain(d1, async (m) => void seen.push(m), { now: clock(T0) });

    expect(res).toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, topic: "audit.record", attempts: 1 });
    expect(seen[0]!.payload).toEqual({ action: "x" });
    expect(rowById(raw, id).status).toBe("done");
    expect(rowById(raw, id).attempts).toBe(1);
  });

  it("reschedules with exponential backoff on failure (message is NOT lost)", async () => {
    const { d1, raw } = makeD1();
    const id = await enqueue(d1, "audit.record", { a: 1 }, { now: clock(T0) });

    const res = await drain(d1, async () => { throw new Error("boom"); }, { now: clock(T0) });

    expect(res).toEqual({ claimed: 1, delivered: 0, retried: 1, failed: 0 });
    const r = rowById(raw, id);
    expect(r.status).toBe("pending"); // still queued, durable
    expect(r.attempts).toBe(1);
    expect(r.last_error).toBe("boom");
    expect(r.next_attempt_at).toBe(new Date(T0 + 1_000).toISOString()); // base backoff
  });

  it("does not claim rows whose next_attempt_at is in the future", async () => {
    const { d1 } = makeD1();
    await enqueue(d1, "t", { a: 1 }, { now: clock(T0) });
    // first failure pushes next_attempt_at to T0+1s
    await drain(d1, async () => { throw new Error("boom"); }, { now: clock(T0) });
    // draining again before the row is due claims nothing
    const early = await drain(d1, async () => { throw new Error("should-not-run"); }, { now: clock(T0 + 500) });
    expect(early.claimed).toBe(0);
  });

  it("moves a row to the terminal failed state after maxAttempts (still retained)", async () => {
    const { d1, raw } = makeD1();
    const id = await enqueue(d1, "audit.record", { a: 1 }, { now: clock(T0) });
    const boom: Parameters<typeof drain>[1] = async () => { throw new Error("nope"); };

    const r1 = await drain(d1, boom, { now: clock(T0), maxAttempts: 2 });
    expect(r1).toMatchObject({ retried: 1, failed: 0 });
    expect(rowById(raw, id).status).toBe("pending");

    // second attempt reaches maxAttempts -> failed
    const r2 = await drain(d1, boom, { now: clock(T0 + 1_000), maxAttempts: 2 });
    expect(r2).toMatchObject({ retried: 0, failed: 1 });

    const r = rowById(raw, id);
    expect(r.status).toBe("failed");
    expect(r.attempts).toBe(2);
    expect(r.last_error).toBe("nope");
    // durability: the record is still in the table, never dropped
    expect(allRows(raw)).toHaveLength(1);
  });

  it("a later drain re-delivers a recovered failure and marks it done", async () => {
    const { d1, raw } = makeD1();
    const id = await enqueue(d1, "t", { a: 1 }, { now: clock(T0) });
    await drain(d1, async () => { throw new Error("boom"); }, { now: clock(T0) });
    // consumer recovers; drain once the row is due again
    const res = await drain(d1, async () => {}, { now: clock(T0 + 1_000) });
    expect(res).toMatchObject({ delivered: 1 });
    expect(rowById(raw, id).status).toBe("done");
  });

  it("claims oldest-due-first and honors batchSize", async () => {
    const { d1 } = makeD1();
    await enqueue(d1, "t", { i: 1 }, { id: "a", now: clock(T0) });
    await enqueue(d1, "t", { i: 2 }, { id: "b", now: clock(T0 + 1) });
    await enqueue(d1, "t", { i: 3 }, { id: "c", now: clock(T0 + 2) });

    const order: string[] = [];
    const res = await drain(d1, async (m) => void order.push(m.id), { now: clock(T0 + 10), batchSize: 2 });
    expect(res.claimed).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("pruneOutbox (retention: delete old terminal rows only)", () => {
  // Insert an already-terminal row with an explicit created_at (enqueue only makes pending).
  function seedTerminal(
    raw: ReturnType<typeof makeD1>["raw"],
    id: string,
    status: "done" | "failed",
    createdAt: string,
  ): void {
    raw
      .prepare(
        `INSERT INTO freeq_outbox (id, topic, payload, status, attempts, next_attempt_at, created_at, last_error)
         VALUES (?, 'audit.record', '{}', ?, 1, ?, ?, NULL)`,
      )
      .run(id, status, createdAt, createdAt);
  }

  const NOW = Date.parse("2026-08-11T00:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1_000).toISOString();

  it("deletes done/failed rows past their window, keeps pending and recent terminal rows", async () => {
    const { d1, raw } = makeD1();
    seedTerminal(raw, "old-done", "done", daysAgo(5)); // > 3d done window -> pruned
    seedTerminal(raw, "fresh-done", "done", daysAgo(1)); // < 3d -> kept
    seedTerminal(raw, "old-failed", "failed", daysAgo(40)); // > 30d failed window -> pruned
    seedTerminal(raw, "recent-failed", "failed", daysAgo(10)); // < 30d -> kept
    await enqueue(d1, "evt.notification", { id: "n" }, { id: "still-pending", now: clock(NOW - 999 * 24 * 60 * 60 * 1_000) });

    const res = await pruneOutbox(d1, { now: () => NOW });

    expect(res).toEqual({ deleted: 2 });
    expect(rowById(raw, "old-done")).toBeUndefined();
    expect(rowById(raw, "old-failed")).toBeUndefined();
    expect(rowById(raw, "fresh-done").status).toBe("done");
    expect(rowById(raw, "recent-failed").status).toBe("failed");
    expect(rowById(raw, "still-pending").status).toBe("pending"); // never pruned, however old
  });

  it("honors caller-supplied retention windows", async () => {
    const { d1, raw } = makeD1();
    seedTerminal(raw, "d", "done", daysAgo(2));
    const res = await pruneOutbox(d1, { now: () => NOW, doneRetentionMs: 24 * 60 * 60 * 1_000 });
    expect(res).toEqual({ deleted: 1 });
    expect(rowById(raw, "d")).toBeUndefined();
  });
});

describe("backoffMs", () => {
  it("doubles per attempt from the base and caps at maxDelayMs", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(1, { baseDelayMs: 500 })).toBe(500);
    expect(backoffMs(100, { baseDelayMs: 1_000, maxDelayMs: 60_000 })).toBe(60_000);
    expect(backoffMs(0)).toBe(1_000); // clamped to attempt 1
  });
});
