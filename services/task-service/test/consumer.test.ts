import { describe, it, expect } from "vitest";
import { createEvent, type DubEventEnvelope } from "@dub/events";
import type { MessageBatch, Message } from "@cloudflare/workers-types";
import { buildQueueHandler } from "../src/consumer";
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
