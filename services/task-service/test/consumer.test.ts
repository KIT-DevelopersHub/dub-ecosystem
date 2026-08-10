import { describe, it, expect } from "vitest";
import { createEvent, type DubEventEnvelope } from "@dub/events";
import type { MessageBatch, Message } from "@cloudflare/workers-types";
import { buildQueueHandler, dispatchEvent } from "../src/consumer";
import { buildApp } from "../src/app";
import { makeHarness } from "./helpers";

function makeBatch(envelopes: DubEventEnvelope[]): { batch: MessageBatch<DubEventEnvelope>; acked: number[]; retried: number[] } {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = envelopes.map((body, i) => ({
    id: String(i),
    body,
    ack: () => acked.push(i),
    retry: () => retried.push(i),
  })) as unknown as Message<DubEventEnvelope>[];
  return { batch: { messages, queue: "dub-q-evt-task", ackAll() {}, retryAll() {} } as unknown as MessageBatch<DubEventEnvelope>, acked, retried };
}

async function seedTask(h: ReturnType<typeof makeHarness>, id: string, eventId: string): Promise<void> {
  await h.repo.insert({
    id,
    eventId,
    title: "T",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId: null,
    dueAt: null,
    origin: "internal",
    createdBy: "usr_alice",
    now: "2026-08-09T00:00:00Z",
  });
}

describe("queue consumer: event.archived", () => {
  it("bulk-archives every task of the event without emitting per-task events", async () => {
    const h = makeHarness();
    await seedTask(h, "task_1", "evt_1");
    await seedTask(h, "task_2", "evt_1");
    await seedTask(h, "task_3", "evt_other");
    const env = createEvent("event.archived", { eventId: "evt_1" }, { requestId: "r", actorId: null });
    const { batch, acked } = makeBatch([env]);
    await buildQueueHandler(h.deps)(batch, {});
    expect(acked).toEqual([0]);
    expect(await h.repo.getById("task_1")).toBeNull();
    expect(await h.repo.getById("task_2")).toBeNull();
    expect(await h.repo.getById("task_3")).not.toBeNull();
    // compensation must not fan out individual task.archived events.
    expect(h.events.published).toHaveLength(0);
  });

  it("is idempotent on redelivery of the same envelope id", async () => {
    const h = makeHarness();
    await seedTask(h, "task_1", "evt_1");
    const env = createEvent("event.archived", { eventId: "evt_1" }, { requestId: "r", actorId: null });
    await buildQueueHandler(h.deps)(makeBatch([env]).batch, {});
    expect(await h.repo.getById("task_1")).toBeNull();
    // a new live task appears, then the SAME envelope is redelivered.
    await seedTask(h, "task_2", "evt_1");
    await buildQueueHandler(h.deps)(makeBatch([env]).batch, {});
    expect(await h.repo.getById("task_2")).not.toBeNull(); // untouched: dedup by envelope.id
  });
});

// Free-tier consumer path: the same compensation reached over the HTTP landing route
// (POST /internal/events-async) that event-service's freeq drain POSTs to, and the
// dispatchEvent seam it shares with the Queue consumer.
describe("dispatchEvent (free-tier single-envelope path)", () => {
  it("runs event.archived compensation with envelope.id idempotency", async () => {
    const h = makeHarness();
    await seedTask(h, "task_1", "evt_1");
    const env = createEvent("event.archived", { eventId: "evt_1" }, { requestId: "r", actorId: null });
    await dispatchEvent(h.deps, env);
    expect(await h.repo.getById("task_1")).toBeNull();
    // redelivery of the same id is a no-op (a new live task survives).
    await seedTask(h, "task_2", "evt_1");
    await dispatchEvent(h.deps, env);
    expect(await h.repo.getById("task_2")).not.toBeNull();
  });

  it("acks an unknown/unsubscribed event name (no handler)", async () => {
    const h = makeHarness();
    await seedTask(h, "task_1", "evt_1");
    const env = createEvent("task.created", { taskId: "task_x", eventId: "evt_1" }, { requestId: "r", actorId: null });
    await dispatchEvent(h.deps, env); // no handler for task.created here -> no-op
    expect(await h.repo.getById("task_1")).not.toBeNull();
    expect(h.events.published).toHaveLength(0);
  });
});

describe("POST /internal/events-async (free-tier landing route)", () => {
  const INIT = { "content-type": "application/json", "x-dub-internal": "1" };

  it("404s without the x-dub-internal marker (never public)", async () => {
    const app = buildApp(makeHarness().deps);
    const res = await app.fetch(
      new Request("https://task/internal/events-async", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createEvent("event.archived", { eventId: "evt_1" }, { requestId: "r", actorId: null })),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("archives the event's tasks and returns 202", async () => {
    const h = makeHarness();
    await seedTask(h, "task_1", "evt_1");
    await seedTask(h, "task_2", "evt_1");
    const app = buildApp(h.deps);
    const res = await app.fetch(
      new Request("https://task/internal/events-async", {
        method: "POST",
        headers: INIT,
        body: JSON.stringify(createEvent("event.archived", { eventId: "evt_1" }, { requestId: "r", actorId: null })),
      }),
    );
    expect(res.status).toBe(202);
    expect(await h.repo.getById("task_1")).toBeNull();
    expect(await h.repo.getById("task_2")).toBeNull();
    expect(h.events.published).toHaveLength(0); // compensation must not fan out
  });

  it("400s on a malformed envelope", async () => {
    const app = buildApp(makeHarness().deps);
    const res = await app.fetch(
      new Request("https://task/internal/events-async", {
        method: "POST",
        headers: INIT,
        body: JSON.stringify({ nope: true }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
