// Free-tier change-log landing route (POST /internal/events-async). The dropped
// dub-q-evt-mobile-bff Queue consumer's job — appending the differential-sync change_log
// from task.*/event.*/action.* events — arrives here over a Service Binding instead. Same
// append path as the queue lane (ingestChangeLogEvent), same idempotency (event_id), and a
// non-2xx keeps the upstream freeq row pending (no loss). The x-dub-internal marker gates it.
import { describe, it, expect } from "vitest";
import type { DubEventEnvelope } from "@dub/events";
import { HDR_INTERNAL } from "@dub/observability";
import { buildApp } from "../src/app";
import type { ChangeLogEntry } from "../src/change-log";
import { makeHarness, jsonInit } from "./helpers";

function taskCreated(id: string, taskId: string): DubEventEnvelope {
  return {
    name: "task.created",
    version: 1,
    id,
    occurredAt: "2026-08-11T00:00:00.000Z",
    requestId: "req_up_1",
    actorId: "usr_alice",
    payload: { taskId, title: "T" } as unknown as DubEventEnvelope["payload"],
  };
}

const INTERNAL = { [HDR_INTERNAL]: "1" };

describe("POST /internal/events-async", () => {
  it("403 without the x-dub-internal Service-Binding marker (no append)", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/internal/events-async", jsonInit(taskCreated("evt_1", "tsk_1")));
    expect(res.status).toBe(403);
    expect(h.changeLogStore.entries).toHaveLength(0);
  });

  it("202 + appends one change_log row for a subscribed task/event/action event", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/internal/events-async", jsonInit(taskCreated("evt_1", "tsk_1"), INTERNAL));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, applied: true });
    expect(h.changeLogStore.entries).toHaveLength(1);
    const row = h.changeLogStore.entries[0] as ChangeLogEntry;
    expect(row.entityType).toBe("task");
    expect(row.entityId).toBe("tsk_1");
    expect(row.op).toBe("upsert");
  });

  it("maps an *.archived verb to a delete tombstone", async () => {
    const h = makeHarness();
    const env: DubEventEnvelope = {
      name: "event.archived",
      version: 1,
      id: "evt_arch",
      occurredAt: "2026-08-11T00:00:00.000Z",
      requestId: "req",
      actorId: null,
      payload: { eventId: "ev_9" } as unknown as DubEventEnvelope["payload"],
    };
    const res = await buildApp(h.deps).request("/internal/events-async", jsonInit(env, INTERNAL));
    expect(res.status).toBe(202);
    expect(h.changeLogStore.entries[0]?.op).toBe("delete");
    expect(h.changeLogStore.entries[0]?.entityType).toBe("event");
  });

  it("is idempotent: a redelivered envelope (same id) does not double-append", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    await app.request("/internal/events-async", jsonInit(taskCreated("evt_dup", "tsk_1"), INTERNAL));
    const res2 = await app.request("/internal/events-async", jsonInit(taskCreated("evt_dup", "tsk_1"), INTERNAL));
    expect(res2.status).toBe(202);
    expect(h.changeLogStore.entries).toHaveLength(1);
  });

  it("202 applied:false ACKs an unsubscribed event (forward-compat, no append)", async () => {
    const h = makeHarness();
    const env: DubEventEnvelope = {
      name: "chat.message.created" as DubEventEnvelope["name"],
      version: 1,
      id: "evt_chat",
      occurredAt: "2026-08-11T00:00:00.000Z",
      requestId: "req",
      actorId: null,
      payload: {} as DubEventEnvelope["payload"],
    };
    const res = await buildApp(h.deps).request("/internal/events-async", jsonInit(env, INTERNAL));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, applied: false });
    expect(h.changeLogStore.entries).toHaveLength(0);
  });

  it("400 on a malformed envelope (missing id / name)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const noId = await app.request("/internal/events-async", jsonInit({ name: "task.created", payload: {} }, INTERNAL));
    expect(noId.status).toBe(400);
    const noName = await app.request("/internal/events-async", jsonInit({ id: "x", payload: {} }, INTERNAL));
    expect(noName.status).toBe(400);
  });

  it("5xx (upstream row kept pending) when the append store throws", async () => {
    const h = makeHarness();
    h.deps.changeLogStore = {
      async append(): Promise<void> {
        throw new Error("d1 down");
      },
    };
    const res = await buildApp(h.deps).request("/internal/events-async", jsonInit(taskCreated("evt_err", "tsk_1"), INTERNAL));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
