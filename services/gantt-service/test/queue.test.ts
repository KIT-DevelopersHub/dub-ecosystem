import { describe, it, expect } from "vitest";
import type { MessageBatch } from "@cloudflare/workers-types";
import { createEvent, type DubEventEnvelope } from "@dub/events";
import { buildQueueConsumer } from "../src/queue";
import type { Env } from "../src/env";
import type { AppDeps } from "../src/ports";
import { fakeCache, fakeViewRepo, fakeRealtime } from "./helpers";

function batchOf(...events: DubEventEnvelope[]): MessageBatch<DubEventEnvelope> {
  return {
    queue: "dub-q-evt-gantt",
    messages: events.map((body) => ({
      id: body.id,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<DubEventEnvelope>;
}

const ctx = { requestId: "req_test", actorId: "user_a" as string | null };

describe("gantt-service queue consumer", () => {
  it("purges the DTO cache on task.status_changed", async () => {
    const cache = fakeCache();
    const deps: AppDeps = { cache: () => cache, views: () => fakeViewRepo(), upstream: () => ({}) as never, authClient: () => ({}) as never, realtime: () => fakeRealtime() };
    const consume = buildQueueConsumer({} as Env, deps);
    const evt = createEvent("task.status_changed", { taskId: "task_a", eventId: "event_1", previousStatus: "todo", status: "done" }, ctx);
    const batch = batchOf(evt);
    await consume(batch, {} as Env);
    expect(cache.purges).toEqual(["event_1"]);
  });

  it("event.archived purges cache AND reaps view-state rows", async () => {
    const cache = fakeCache();
    const views = fakeViewRepo();
    await views.put("user_a", "event_1", { zoom: "day", collapsedTaskIds: [] });
    const deps: AppDeps = { cache: () => cache, views: () => views, upstream: () => ({}) as never, authClient: () => ({}) as never, realtime: () => fakeRealtime() };
    const consume = buildQueueConsumer({} as Env, deps);
    const evt = createEvent("event.archived", { eventId: "event_1" }, ctx);
    const batch = batchOf(evt);
    await consume(batch, {} as Env);
    expect(cache.purges).toEqual(["event_1"]);
    expect((await views.get("user_a", "event_1")).zoom).toBe("week"); // reaped -> default
  });

  it("purges once per task.dependency_changed", async () => {
    const cache = fakeCache();
    const deps: AppDeps = { cache: () => cache, views: () => fakeViewRepo(), upstream: () => ({}) as never, authClient: () => ({}) as never, realtime: () => fakeRealtime() };
    const consume = buildQueueConsumer({} as Env, deps);
    const evt = createEvent("task.dependency_changed", { taskId: "task_b", eventId: "event_1", added: ["task_a"], removed: [] }, ctx);
    const batch = batchOf(evt);
    await consume(batch, {} as Env);
    expect(cache.purges).toEqual(["event_1"]);
  });
});
