import { describe, it, expect } from "vitest";
import { DubError } from "@dub/errors";
import { buildApp } from "../src/app";
import { buildSync } from "../src/sync";
import { makeHarness, authHeaders, ALICE } from "./helpers";

function seedEmpty(h: ReturnType<typeof makeHarness>): void {
  h.event.on("GET", "/events", { items: [], nextCursor: null });
  h.task.on("GET", "/tasks", { items: [], nextCursor: null });
  h.notification.on("GET", "/inbox", { items: [], nextCursor: null });
}

describe("buildSync — first pull (no cursor)", () => {
  it("merges events + own tasks + inbox into tagged change entries", async () => {
    const h = makeHarness();
    h.event.on("GET", "/events", { items: [{ id: "evt_1", title: "E", phase: "live", startsAt: null }], nextCursor: null });
    h.task.on("GET", "/tasks", { items: [{ id: "tsk_1", title: "T", status: "todo", version: 1 }], nextCursor: null });
    h.notification.on("GET", "/inbox", { items: [{ id: "ntf_1", type: "task.assigned", title: "n" }], nextCursor: null });

    const res = await buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, {}, () => "2026-08-09T00:00:00.000Z");

    expect(res.items).toEqual([
      { resource: "event", id: "evt_1", data: { id: "evt_1", title: "E", phase: "live", startsAt: null } },
      { resource: "task", id: "tsk_1", data: { id: "tsk_1", title: "T", status: "todo", version: 1 } },
      { resource: "notification", id: "ntf_1", data: { id: "ntf_1", type: "task.assigned", title: "n" } },
    ]);
    expect(res.serverTime).toBe("2026-08-09T00:00:00.000Z");
    expect(res.nextCursor).toBeTypeOf("string");
  });

  it("does not send updatedSince on the first pull, scopes tasks to the caller", async () => {
    const h = makeHarness();
    seedEmpty(h);
    await buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, { limit: 25 });

    expect(h.event.calls[0]?.opts?.query).toEqual({ limit: 25 });
    expect(h.task.calls[0]?.opts?.query).toEqual({ limit: 25, assigneeId: ALICE });
    expect(h.event.calls[0]?.opts?.query).not.toHaveProperty("updatedSince");
  });

  it("clamps limit into [1, 200], defaulting when absent/invalid", async () => {
    const h = makeHarness();
    seedEmpty(h);
    await buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, {});
    expect(h.event.calls[0]?.opts?.query).toMatchObject({ limit: 50 });

    seedEmpty(h);
    await buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, { limit: 9999 });
    expect(h.event.calls.at(-1)?.opts?.query).toMatchObject({ limit: 200 });
  });
});

describe("buildSync — full pagination (no data loss past page 1)", () => {
  it("follows each source's nextCursor until the end and merges every page", async () => {
    const h = makeHarness();
    h.event.on("GET", "/events", { items: [], nextCursor: null });
    h.notification.on("GET", "/inbox", { items: [], nextCursor: null });
    // /tasks paginates: page 1 -> cursor "c1", page 2 -> end.
    h.task.on("GET", "/tasks", ({ opts }: { opts?: { query?: Record<string, unknown> } }) => {
      const cursor = opts?.query?.cursor;
      if (!cursor) return { items: [{ id: "tsk_1", title: "T1", status: "todo", version: 1 }], nextCursor: "c1" };
      if (cursor === "c1") return { items: [{ id: "tsk_2", title: "T2", status: "todo", version: 1 }], nextCursor: null };
      throw new Error(`unexpected cursor: ${String(cursor)}`);
    });

    const res = await buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, {});

    const entries = res.items as { resource: string; id: string }[];
    const taskIds = entries.filter((i) => i.resource === "task").map((i) => i.id);
    expect(taskIds).toEqual(["tsk_1", "tsk_2"]);
    // exactly two upstream calls: page 1 (no cursor) then page 2 (cursor c1).
    expect(h.task.calls).toHaveLength(2);
    expect(h.task.calls[0]?.opts?.query).not.toHaveProperty("cursor");
    expect(h.task.calls[1]?.opts?.query?.cursor).toBe("c1");
  });
});

describe("buildSync — incremental pull (cursor round-trip)", () => {
  it("forwards the previous serverTime as updatedSince on the next pull", async () => {
    const h = makeHarness();
    seedEmpty(h);
    const first = await buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, {}, () => "2026-08-09T10:00:00.000Z");

    // replay the returned cursor
    seedEmpty(h);
    await buildSync(h.deps, { requestId: "r2", userId: ALICE }, ALICE, { cursor: first.nextCursor! });

    const q = h.task.calls.at(-1)?.opts?.query as Record<string, unknown>;
    expect(q.updatedSince).toBe("2026-08-09T10:00:00.000Z");
  });

  it("rejects a tampered cursor with MOBILE_SYNC_CURSOR_EXPIRED (400)", async () => {
    const h = makeHarness();
    seedEmpty(h);
    await expect(buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, { cursor: "not-a-cursor" })).rejects.toMatchObject({
      code: "MOBILE_SYNC_CURSOR_EXPIRED",
      status: 400,
    });
  });
});

describe("buildSync — failure semantics", () => {
  it("is fail-closed: one upstream error rejects the pull (cursor unchanged)", async () => {
    const h = makeHarness();
    h.event.on("GET", "/events", { items: [], nextCursor: null });
    h.task.on("GET", "/tasks", new DubError("UPSTREAM_UNAVAILABLE", "down", { status: 502 }));
    h.notification.on("GET", "/inbox", { items: [], nextCursor: null });

    await expect(buildSync(h.deps, { requestId: "r1", userId: ALICE }, ALICE, {})).rejects.toMatchObject({ status: 502 });
  });
});

describe("GET /m/v1/sync (through the app)", () => {
  it("passes ?cursor & ?limit query through to buildSync", async () => {
    const h = makeHarness();
    seedEmpty(h);
    const first = await buildApp(h.deps).request("/m/v1/sync", { headers: authHeaders() });
    const body = (await first.json()) as { nextCursor: string };

    // reset call log by using a fresh harness turn is unnecessary; assert on the 2nd call
    seedEmpty(h);
    const res = await buildApp(h.deps).request(`/m/v1/sync?cursor=${encodeURIComponent(body.nextCursor)}&limit=10`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const q = h.task.calls.at(-1)?.opts?.query as Record<string, unknown>;
    expect(q.updatedSince).toBeTypeOf("string");
    expect(q.limit).toBe(10);
  });

  it("returns 400 for a bad cursor via the app error handler", async () => {
    const h = makeHarness();
    seedEmpty(h);
    const res = await buildApp(h.deps).request("/m/v1/sync?cursor=not-a-valid-cursor", { headers: authHeaders() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MOBILE_SYNC_CURSOR_EXPIRED");
  });
});
