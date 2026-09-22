// Write-amplification regression: DRAIN_OPTS.maxAttempts is FINITE, so a permanently
// undeliverable row reaches the terminal `failed` state and STOPS being re-written every
// tick (the unbounded-maxAttempts bug re-UPDATEd deferred rows forever). Plus pruneAll:
// terminal rows are eventually deleted so the table stays bounded; pending rows never are.
import { describe, it, expect } from "vitest";
import { drain } from "@dub/freeq";
import { DRAIN_OPTS, pruneAll } from "../src/drain-all";
import { makeDeliver } from "../src/routing";
import type { Env } from "../src/env";
import { makeD1, fakeSvc, seed, readRow } from "./d1";

describe("DRAIN_OPTS.maxAttempts is finite (write-amplification fix)", () => {
  it("is in the intended 8..16 window", () => {
    expect(Number.isFinite(DRAIN_OPTS.maxAttempts)).toBe(true);
    expect(DRAIN_OPTS.maxAttempts).toBeGreaterThanOrEqual(8);
    expect(DRAIN_OPTS.maxAttempts).toBeLessThanOrEqual(16);
  });

  it("a permanently-deferred row goes terminal `failed` after maxAttempts, then never churns again", async () => {
    const { d1, raw } = makeD1();
    const env = {} as unknown as Env; // no SVC_TASK bound -> evt.task DEFERS every time
    seed(raw, "x1", "evt.task", { id: "e" });

    const max = DRAIN_OPTS.maxAttempts;
    let t = Date.parse("2026-01-01T00:00:00.000Z");
    // Drive well past maxAttempts, advancing the clock 2h each pass (beyond the 1h backoff
    // cap) so the row is due and re-claimed every pass until it terminates.
    for (let i = 0; i < max + 5; i++) {
      await drain(d1, makeDeliver(env), { ...DRAIN_OPTS, now: () => t });
      t += 2 * 60 * 60 * 1000;
    }

    const row = readRow(raw, "x1")!;
    expect(row.status).toBe("failed"); // terminal — not pending forever
    expect(row.attempts).toBe(max); // capped exactly at maxAttempts

    // Once failed it is no longer a 'pending' row, so the claim query skips it: a further
    // drain does NOT touch it (attempts unchanged) — the churn (and its writes) has stopped.
    await drain(d1, makeDeliver(env), { ...DRAIN_OPTS, now: () => t });
    expect(readRow(raw, "x1")!.attempts).toBe(max);
  });
});

describe("pruneAll (retention across bound DBs, best-effort, pending-safe)", () => {
  const OLD = "2000-01-01T00:00:00.000Z";

  function seedTerminal(raw: ReturnType<typeof makeD1>["raw"], id: string, status: "done" | "failed", at: string): void {
    raw
      .prepare(
        `INSERT INTO freeq_outbox (id, topic, payload, status, attempts, next_attempt_at, created_at, last_error)
         VALUES (?, 'audit.record', '{}', ?, 1, ?, ?, NULL)`,
      )
      .run(id, status, at, at);
  }

  it("deletes old done+failed rows from every bound DB but keeps pending rows", async () => {
    const core = makeD1();
    const authDb = makeD1();
    seedTerminal(core.raw, "c-done", "done", OLD);
    seedTerminal(core.raw, "c-failed", "failed", OLD);
    seed(core.raw, "c-pending", "evt.notification", { id: "n" }, OLD); // pending: must survive
    seedTerminal(authDb.raw, "a-done", "done", OLD);

    const env = { DB_CORE: core.d1, DB_AUTH: authDb.d1 } as unknown as Env;
    const out = await pruneAll(env, { now: () => Date.parse("2026-01-01T00:00:00.000Z") });

    expect(out.DB_CORE).toEqual({ ok: true, deleted: 2 });
    expect(out.DB_AUTH).toEqual({ ok: true, deleted: 1 });
    expect(out.DB_DRIVE).toBeUndefined(); // unbound -> skipped
    expect(readRow(core.raw, "c-done")).toBeUndefined();
    expect(readRow(core.raw, "c-failed")).toBeUndefined();
    expect(readRow(core.raw, "c-pending")).toMatchObject({ status: "pending" });
    expect(readRow(authDb.raw, "a-done")).toBeUndefined();
  });

  it("respects per-status retention windows (failed kept longer than done)", async () => {
    const core = makeD1();
    const now = Date.parse("2026-01-10T00:00:00.000Z");
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    seedTerminal(core.raw, "done-5d", "done", fiveDaysAgo); // > 3d done window -> pruned
    seedTerminal(core.raw, "failed-5d", "failed", fiveDaysAgo); // < 30d failed window -> kept

    const env = { DB_CORE: core.d1 } as unknown as Env;
    const out = await pruneAll(env, { now: () => now });

    expect(out.DB_CORE).toEqual({ ok: true, deleted: 1 });
    expect(readRow(core.raw, "done-5d")).toBeUndefined();
    expect(readRow(core.raw, "failed-5d")).toMatchObject({ status: "failed" });
  });

  it("one DB's failure is recorded but does not abort the others", async () => {
    const core = makeD1();
    seedTerminal(core.raw, "c-done", "done", OLD);
    const broken = {
      prepare() {
        throw new Error("boom: auth-outbox unavailable");
      },
    } as unknown as import("@cloudflare/workers-types").D1Database;

    const env = { DB_CORE: core.d1, DB_AUTH: broken } as unknown as Env;
    const out = await pruneAll(env, { now: () => Date.parse("2026-01-01T00:00:00.000Z") });

    expect(out.DB_AUTH).toMatchObject({ ok: false });
    expect(out.DB_CORE).toEqual({ ok: true, deleted: 1 });
    expect(readRow(core.raw, "c-done")).toBeUndefined();
  });
});
