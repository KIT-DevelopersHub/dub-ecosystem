import { describe, it, expect } from "vitest";
import type { MessageBatch, Message } from "@cloudflare/workers-types";
import { namespaceOf, tablesOf, isLintClean, lintMigration, type DbClient, type DbRunResult } from "@dub/db";
import { createEvent, type DubEventEnvelope } from "@dub/events";
import { MOBILE_MIGRATIONS } from "../src/migrations";
import {
  changeLogEntryFromEvent,
  createChangeLogConsumer,
  D1ChangeLogStore,
  type ChangeLogEntry,
  type ChangeLogStore,
} from "../src/change-log";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------
describe("mobile migrations", () => {
  it("every migration is declared in the mobile namespace", () => {
    for (const m of MOBILE_MIGRATIONS) expect(m.namespace).toBe("mobile");
  });

  it("all tables touched stay inside the mobile_* namespace (no boundary violation)", () => {
    for (const m of MOBILE_MIGRATIONS) {
      for (const table of tablesOf(m.up)) {
        expect(namespaceOf(table)).toBe("mobile");
      }
    }
  });

  it("passes the @dub/db migration lint", () => {
    for (const m of MOBILE_MIGRATIONS) {
      const issues = lintMigration(m);
      expect(isLintClean(issues), JSON.stringify(issues)).toBe(true);
    }
  });

  it("0001 creates the P0 tables (devices + push_deliveries)", () => {
    const tables = tablesOf(MOBILE_MIGRATIONS[0]!.up);
    expect(tables).toContain("mobile_devices");
    expect(tables).toContain("mobile_push_deliveries");
  });

  it("0002 adds the offline-sync pair (change_log + mutations)", () => {
    const offline = MOBILE_MIGRATIONS.find((m) => m.id === "0002_offline_sync");
    expect(offline, "0002_offline_sync migration exists").toBeTruthy();
    const tables = tablesOf(offline!.up);
    expect(tables).toContain("mobile_change_log");
    expect(tables).toContain("mobile_mutations");
  });

  it("migration ids are unique and ordered (forward-only)", () => {
    const ids = MOBILE_MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids]).toEqual([...ids].sort());
  });
});

// ---------------------------------------------------------------------------
// pure event -> change-log-entry mapping
// ---------------------------------------------------------------------------
const CTX = { requestId: "req_1", actorId: "usr_alice", occurredAt: "2026-08-09T00:00:00.000Z" };

describe("changeLogEntryFromEvent", () => {
  it("maps a task.created event to an upsert entry keyed by taskId", () => {
    const e = createEvent("task.created", { taskId: "task_1", eventId: "evt_1" }, CTX);
    const entry = changeLogEntryFromEvent(e);
    expect(entry).toMatchObject({
      eventId: e.id,
      eventName: "task.created",
      entityType: "task",
      entityId: "task_1",
      op: "upsert",
      actorId: "usr_alice",
      occurredAt: CTX.occurredAt,
    });
    expect(JSON.parse(entry!.payloadJson)).toEqual({ taskId: "task_1", eventId: "evt_1" });
  });

  it("maps an *.archived event to a delete op", () => {
    const e = createEvent("task.archived", { taskId: "task_9", eventId: "evt_9" }, CTX);
    expect(changeLogEntryFromEvent(e)?.op).toBe("delete");
  });

  it("maps event.* to entityType=event keyed by eventId", () => {
    const e = createEvent("event.created", { eventId: "evt_1", title: "Kickoff", phase: "planning" }, CTX);
    expect(changeLogEntryFromEvent(e)).toMatchObject({ entityType: "event", entityId: "evt_1", op: "upsert" });
  });

  it("maps action.* to entityType=action keyed by actionId", () => {
    const e = createEvent("action.status_changed", { actionId: "act_1", eventId: "evt_1" }, CTX);
    expect(changeLogEntryFromEvent(e)).toMatchObject({ entityType: "action", entityId: "act_1", op: "upsert" });
  });

  it("returns null for events outside task/event/action domains", () => {
    const e = createEvent("notification.requested", { type: "task_assigned", recipientIds: ["usr_1"], title: "t", body: "b" }, CTX);
    expect(changeLogEntryFromEvent(e)).toBeNull();
  });

  it("returns null (no garbage row) when the entity id is missing", () => {
    const bogus = { name: "task.created", version: 1, id: "01J", occurredAt: CTX.occurredAt, requestId: "r", actorId: null, payload: {} } as unknown as DubEventEnvelope;
    expect(changeLogEntryFromEvent(bogus)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// consumer append (dub-q-evt-mobile-bff)
// ---------------------------------------------------------------------------
class MemoryChangeLogStore implements ChangeLogStore {
  entries: ChangeLogEntry[] = [];
  async append(entry: ChangeLogEntry): Promise<void> {
    // mirror the ON CONFLICT (event_id) idempotency of the real store
    if (this.entries.some((x) => x.eventId === entry.eventId)) return;
    this.entries.push(entry);
  }
}

function fakeBatch(bodies: DubEventEnvelope[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = bodies.map((body, i) => ({
    body,
    ack: () => acked.push(i),
    retry: () => retried.push(i),
  })) as unknown as Message<DubEventEnvelope>[];
  return { batch: { messages } as unknown as MessageBatch<DubEventEnvelope>, acked, retried };
}

describe("change-log queue consumer", () => {
  it("appends one change_log row per task/event/action message and acks them", async () => {
    const store = new MemoryChangeLogStore();
    const consumer = createChangeLogConsumer(store);
    const events: DubEventEnvelope[] = [
      createEvent("task.created", { taskId: "task_1", eventId: "evt_1" }, CTX),
      createEvent("event.updated", { eventId: "evt_1", changed: ["title"] }, CTX),
      createEvent("action.archived", { actionId: "act_1", eventId: "evt_1" }, CTX),
    ];
    const { batch, acked, retried } = fakeBatch(events);

    await consumer(batch, {});

    expect(store.entries.map((e) => [e.entityType, e.entityId, e.op])).toEqual([
      ["task", "task_1", "upsert"],
      ["event", "evt_1", "upsert"],
      ["action", "act_1", "delete"],
    ]);
    expect(acked).toEqual([0, 1, 2]);
    expect(retried).toEqual([]);
  });

  it("acks unsubscribed event names without appending (forward-compat)", async () => {
    const store = new MemoryChangeLogStore();
    const consumer = createChangeLogConsumer(store);
    // task.dependency_changed is a valid catalog name MO3 does not subscribe to.
    const e = createEvent("task.dependency_changed", { taskId: "task_1", eventId: "evt_1", added: [], removed: [] }, CTX);
    const { batch, acked } = fakeBatch([e]);

    await consumer(batch, {});

    expect(store.entries).toHaveLength(0);
    expect(acked).toEqual([0]);
  });

  it("retries the message when the append store throws (no silent drop)", async () => {
    const failing: ChangeLogStore = {
      append: async () => {
        throw new Error("d1 down");
      },
    };
    const consumer = createChangeLogConsumer(failing, { onError: () => {} });
    const e = createEvent("task.created", { taskId: "task_1", eventId: "evt_1" }, CTX);
    const { batch, acked, retried } = fakeBatch([e]);

    await consumer(batch, {});

    expect(acked).toEqual([]);
    expect(retried).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// D1ChangeLogStore SQL wiring (real INSERT, not a stub)
// ---------------------------------------------------------------------------
class FakeDbClient implements DbClient {
  readonly namespace = "mobile" as const;
  runs: { sql: string; binds: unknown[] }[] = [];
  async first(): Promise<null> {
    return null;
  }
  async all(): Promise<never[]> {
    return [];
  }
  async run(sql: string, ...binds: unknown[]): Promise<DbRunResult> {
    this.runs.push({ sql, binds });
    return { success: true, meta: { changes: 1, durationMs: 0 } };
  }
  async batch(): Promise<DbRunResult[]> {
    return [];
  }
  raw(): never {
    throw new Error("not used");
  }
}

describe("D1ChangeLogStore", () => {
  it("inserts into mobile_change_log with the entry's columns and ON CONFLICT idempotency", async () => {
    const db = new FakeDbClient();
    const store = new D1ChangeLogStore(db);
    const e = createEvent("task.status_changed", { taskId: "task_1", eventId: "evt_1", previousStatus: "todo", status: "in_progress" }, CTX);
    const entry = changeLogEntryFromEvent(e)!;

    await store.append(entry);

    expect(db.runs).toHaveLength(1);
    const { sql, binds } = db.runs[0]!;
    expect(sql).toContain("INSERT INTO mobile_change_log");
    expect(sql).toContain("ON CONFLICT (event_id) DO NOTHING");
    // event_id, event_name, entity_type, entity_id, op, actor_id, occurred_at, payload_json, created_at
    expect(binds.slice(0, 8)).toEqual([
      entry.eventId,
      "task.status_changed",
      "task",
      "task_1",
      "upsert",
      "usr_alice",
      CTX.occurredAt,
      entry.payloadJson,
    ]);
    expect(binds).toHaveLength(9); // + created_at (nowIso)
    expect(typeof binds[8]).toBe("string");
  });
});