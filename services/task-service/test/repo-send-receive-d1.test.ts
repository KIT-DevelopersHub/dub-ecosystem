// Real-SQLite repo tests for the send/receive tables (task_requests, task_cross_links).
// Runs createD1TaskRepo against an authentic node:sqlite D1 seeded with the physical
// migrations (the same .sql that ships to prod), so the CRUD SQL — column list, the
// optimistic-locked `pending`-only transition, event scoping — is exercised for real,
// not against the in-memory fake. Mirrors services/*/test/outbox-d1.ts.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDbClient } from "@dub/db";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1TaskRepo, type TaskRepo, type InsertTaskInput } from "../src/repo";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// The full physical task schema (every *.sql, id-ascending — mirrors infra/d1 collect.ts).
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../infra/d1/migrations/task/", import.meta.url));
function allTaskDdl(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${MIGRATIONS_DIR}${f}`, "utf8"))
    .join("\n");
}

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function makeRepo(): TaskRepo {
  const raw = new DatabaseSync(":memory:");
  raw.exec(allTaskDdl());
  const d1 = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      let args: unknown[] = [];
      const api = {
        bind(...b: unknown[]) {
          args = b.map(norm);
          return api;
        },
        first<T>(): T | null {
          return (stmt.get(...(args as never[])) ?? null) as T | null;
        },
        all<T>() {
          return { results: stmt.all(...(args as never[])) as T[], success: true, meta: {} };
        },
        run() {
          const r = stmt.run(...(args as never[]));
          return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
  return createD1TaskRepo(createDbClient(d1, { namespace: "task" }));
}

const now = "2026-08-20T00:00:00.000Z";
function reqInput(over: Partial<Parameters<TaskRepo["insertRequest"]>[0]> = {}) {
  return {
    id: "treq_1",
    eventId: "evt_1",
    fromUserId: "usr_alice",
    toUserId: "usr_bob",
    fromTeamId: "team_dev",
    toTeamId: null,
    title: "デザインをお願い",
    description: null,
    priority: "medium" as const,
    dueAt: null,
    sourceTaskId: null,
    now,
    ...over,
  };
}

describe("task_requests repo (real D1)", () => {
  it("inserts a pending request and reads it back with every field mapped", async () => {
    const repo = makeRepo();
    const created = await repo.insertRequest(reqInput());
    expect(created).toMatchObject({
      id: "treq_1",
      state: "pending",
      fromUserId: "usr_alice",
      toUserId: "usr_bob",
      fromTeamId: "team_dev",
      version: 1,
      declineReason: null,
      createdTaskId: null,
      decidedAt: null,
    });
    const got = await repo.getRequestById("treq_1");
    expect(got).toEqual(created);
    expect(await repo.getRequestById("treq_missing")).toBeNull();
  });

  it("lists incoming vs outgoing by user, with state + event filters", async () => {
    const repo = makeRepo();
    await repo.insertRequest(reqInput({ id: "treq_1", fromUserId: "usr_alice", toUserId: "usr_bob" }));
    await repo.insertRequest(reqInput({ id: "treq_2", fromUserId: "usr_carol", toUserId: "usr_bob" }));
    await repo.insertRequest(reqInput({ id: "treq_3", fromUserId: "usr_bob", toUserId: "usr_dan", eventId: "evt_2" }));

    const incoming = await repo.listRequests({ box: "incoming", userId: "usr_bob", limit: 50 });
    expect(incoming.items.map((r) => r.id).sort()).toEqual(["treq_1", "treq_2"]);

    const outgoing = await repo.listRequests({ box: "outgoing", userId: "usr_bob", limit: 50 });
    expect(outgoing.items.map((r) => r.id)).toEqual(["treq_3"]);

    const scoped = await repo.listRequests({ box: "outgoing", userId: "usr_bob", eventId: "evt_2", limit: 50 });
    expect(scoped.items.map((r) => r.id)).toEqual(["treq_3"]);
    const none = await repo.listRequests({ box: "outgoing", userId: "usr_bob", eventId: "evt_nope", limit: 50 });
    expect(none.items).toEqual([]);
  });

  it("decideRequest: accepts a pending request (optimistic), then blocks a second decide", async () => {
    const repo = makeRepo();
    await repo.insertRequest(reqInput());
    const ok = await repo.decideRequest("treq_1", { state: "accepted", createdTaskId: "task_x", toTeamId: "team_sponsor" }, 1, now);
    expect(ok).toBe(true);
    const after = await repo.getRequestById("treq_1");
    expect(after).toMatchObject({ state: "accepted", createdTaskId: "task_x", toTeamId: "team_sponsor", version: 2, decidedAt: now });

    // already-decided ⇒ no-op (state != pending), and stale version ⇒ no-op.
    expect(await repo.decideRequest("treq_1", { state: "declined" }, 2, now)).toBe(false);
    const repo2 = makeRepo();
    await repo2.insertRequest(reqInput());
    expect(await repo2.decideRequest("treq_1", { state: "declined", declineReason: "多忙" }, 99, now)).toBe(false);
  });

  it("decideRequest: declines with a reason", async () => {
    const repo = makeRepo();
    await repo.insertRequest(reqInput());
    expect(await repo.decideRequest("treq_1", { state: "declined", declineReason: "スコープ外" }, 1, now)).toBe(true);
    expect(await repo.getRequestById("treq_1")).toMatchObject({ state: "declined", declineReason: "スコープ外" });
  });
});

function taskInput(id: string, eventId: string | null): InsertTaskInput {
  return {
    id,
    eventId,
    title: id,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId: null,
    dueAt: null,
    origin: "internal",
    createdBy: "usr_alice",
    now,
  };
}

describe("task_cross_links repo (real D1)", () => {
  it("inserts a cross-link and lists it by event", async () => {
    const repo = makeRepo();
    // FK parents (node:sqlite enforces foreign_keys): the request + both tasks must exist.
    await repo.insertRequest(reqInput({ id: "treq_1" }));
    await repo.insertRequest(reqInput({ id: "treq_2" }));
    for (const [t, e] of [["task_req", "evt_1"], ["task_acc", "evt_1"], ["task_r2", "evt_2"], ["task_a2", "evt_2"]] as const) {
      await repo.insert(taskInput(t, e));
    }

    const link = await repo.insertCrossLink({
      id: "txl_1",
      requestId: "treq_1",
      requesterTaskId: "task_req",
      requesteeTaskId: "task_acc",
      eventId: "evt_1",
      now,
    });
    expect(link).toMatchObject({ id: "txl_1", requesterTaskId: "task_req", requesteeTaskId: "task_acc", eventId: "evt_1" });

    await repo.insertCrossLink({ id: "txl_2", requestId: "treq_2", requesterTaskId: "task_r2", requesteeTaskId: "task_a2", eventId: "evt_2", now });
    const inEvt1 = await repo.listCrossLinksByEvent("evt_1");
    expect(inEvt1.map((c) => c.id)).toEqual(["txl_1"]);
  });
});
