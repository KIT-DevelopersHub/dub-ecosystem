import { describe, it, expect, vi } from "vitest";
import type { Queue, MessageBatch, Message } from "@cloudflare/workers-types";
import {
  createEvent,
  publishEvent,
  publishEvents,
  createQueueHandler,
  publishAudit,
  publishWebhookEvent,
  SUBSCRIPTIONS,
  CONSUMER_QUEUE_BINDINGS,
  type DubEventEnvelope,
  type ConsumerService,
} from "../src/index";

function fakeQueue() {
  const sent: unknown[] = [];
  const batches: unknown[][] = [];
  const q = {
    send: async (b: unknown) => void sent.push(b),
    sendBatch: async (msgs: Iterable<{ body: unknown }>) => void batches.push([...msgs].map((m) => m.body)),
  } as unknown as Queue<DubEventEnvelope>;
  return { q, sent, batches };
}

const ctx = { requestId: "req_1", actorId: "user_1" as string | null };

describe("@dub/events catalog integrity", () => {
  it("every SUBSCRIPTIONS value is a valid consumer with a queue binding", () => {
    const validConsumers = new Set(Object.keys(CONSUMER_QUEUE_BINDINGS) as ConsumerService[]);
    for (const [name, consumers] of Object.entries(SUBSCRIPTIONS)) {
      for (const c of consumers) {
        expect(validConsumers.has(c)).toBe(true);
        expect(CONSUMER_QUEUE_BINDINGS[c]).toBeTruthy();
      }
      expect(name).not.toContain(".v1"); // no version suffix in names
    }
  });

  it("soft-delete facts are retired (task/event use *.archived, not *.deleted)", () => {
    const names = Object.keys(SUBSCRIPTIONS);
    // task.deleted / event.deleted are fully retired (decision 2)
    expect(names).not.toContain("task.deleted");
    expect(names).not.toContain("event.deleted");
    expect(names).toContain("task.archived");
    expect(names).toContain("event.archived");
    // legitimate real-deletion facts remain (hard delete / link removal)
    const deleted = names.filter((n) => n.endsWith(".deleted")).sort();
    expect(deleted).toEqual(["chat.message.deleted", "file.deleted"]);
    // no version suffixes
    expect(names.some((n) => /\.v\d+$/.test(n))).toBe(false);
  });
});

describe("@dub/events producer", () => {
  it("createEvent builds a complete canonical envelope", () => {
    const e = createEvent("task.created", { taskId: "task_1", eventId: "event_1" }, ctx);
    expect(e.name).toBe("task.created");
    expect(e.version).toBe(1);
    expect(e.id.length).toBeGreaterThan(20);
    expect(e.requestId).toBe("req_1");
    expect(e.actorId).toBe("user_1");
    expect(e.payload.taskId).toBe("task_1");
  });

  it("publishEvent fans out to every subscriber queue", async () => {
    const notif = fakeQueue();
    const gh = fakeQueue();
    const gantt = fakeQueue();
    const mobile = fakeQueue();
    const env = {
      [CONSUMER_QUEUE_BINDINGS.notification]: notif.q,
      [CONSUMER_QUEUE_BINDINGS["github-sync"]]: gh.q,
      [CONSUMER_QUEUE_BINDINGS.gantt]: gantt.q,
      [CONSUMER_QUEUE_BINDINGS["mobile-bff"]]: mobile.q,
    };
    const e = createEvent("task.created", { taskId: "t1", eventId: "e1" }, ctx);
    await publishEvent(env, e);
    expect(notif.sent).toHaveLength(1);
    expect(gh.sent).toHaveLength(1);
    expect(gantt.sent).toHaveLength(1);
    expect(mobile.sent).toHaveLength(1);
  });

  it("throws EVENTS_MISSING_BINDING when a subscriber queue is absent", async () => {
    const e = createEvent("task.created", { taskId: "t1", eventId: "e1" }, ctx);
    await expect(publishEvent({}, e)).rejects.toMatchObject({ code: "EVENTS_MISSING_BINDING" });
  });

  it("zero-subscriber events are a no-op success", async () => {
    const e = createEvent("file.updated", { fileId: "f1" }, ctx);
    await expect(publishEvent({}, e)).resolves.toBeUndefined();
  });

  it("publishEvents batches per queue in chunks of 100", async () => {
    const gantt = fakeQueue();
    const env = { [CONSUMER_QUEUE_BINDINGS.gantt]: gantt.q };
    const events = Array.from({ length: 101 }, () => createEvent("task.dependency_changed", { taskId: "t1", eventId: "e1", added: [], removed: [] }, ctx));
    await publishEvents(env, events);
    expect(gantt.batches.map((b) => b.length)).toEqual([100, 1]);
  });

  it("rejects payloads over 128KB", async () => {
    const big = "x".repeat(130 * 1024);
    const e = createEvent("task.updated", { taskId: "t1", eventId: "e1", changed: [big] }, ctx);
    await expect(publishEvent({ [CONSUMER_QUEUE_BINDINGS["github-sync"]]: fakeQueue().q }, e)).rejects.toMatchObject({ code: "EVENTS_PAYLOAD_TOO_LARGE" });
  });
});

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

describe("@dub/events consumer", () => {
  it("dispatches by name and acks on success", async () => {
    const spy = vi.fn(async () => {});
    const handler = createQueueHandler({ "task.created": spy });
    const e = createEvent("task.created", { taskId: "t1", eventId: "e1" }, ctx);
    const { batch, acked } = fakeBatch([e]);
    await handler(batch, {});
    expect(spy).toHaveBeenCalledOnce();
    expect(acked).toEqual([0]);
  });

  it("retries the failing message only", async () => {
    const handler = createQueueHandler({
      "task.created": async () => {
        throw new Error("boom");
      },
    });
    const e = createEvent("task.created", { taskId: "t1", eventId: "e1" }, ctx);
    const { batch, retried, acked } = fakeBatch([e]);
    await handler(batch, {});
    expect(retried).toEqual([0]);
    expect(acked).toEqual([]);
  });

  it("skips already-processed messages via IdempotencyStore", async () => {
    const spy = vi.fn(async () => {});
    const store = { wasProcessed: async () => true, markProcessed: vi.fn(async () => {}) };
    const handler = createQueueHandler({ "task.created": spy }, { idempotency: store });
    const e = createEvent("task.created", { taskId: "t1", eventId: "e1" }, ctx);
    const { batch, acked } = fakeBatch([e]);
    await handler(batch, {});
    expect(spy).not.toHaveBeenCalled();
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect(acked).toEqual([0]);
  });

  it("acks unknown event names by default (forward-compat)", async () => {
    const handler = createQueueHandler({});
    const e = { name: "future.event", version: 1, id: "x", occurredAt: "", requestId: "r", actorId: null, payload: {} } as unknown as DubEventEnvelope;
    const { batch, acked } = fakeBatch([e]);
    await handler(batch, {});
    expect(acked).toEqual([0]);
  });
});

describe("@dub/events special channels", () => {
  it("publishAudit strips secrets from details before enqueue", async () => {
    const audit = fakeQueue();
    await publishAudit({ AUDIT_QUEUE: audit.q as never }, {
      action: "identity.role.assigned",
      actorId: "user_1",
      orgId: "org_devhub",
      result: "success",
      resourceType: "role",
      resourceId: "role_1",
      details: { token: "secret", note: "ok" },
      requestId: "req_1",
      occurredAt: "2026-08-09T00:00:00Z",
    });
    const sent = audit.sent[0] as { payload: { details: Record<string, unknown> } };
    expect(sent.payload.details.token).toBe("[REDACTED]");
    expect(sent.payload.details.note).toBe("ok");
  });

  it("publishWebhookEvent routes by source", async () => {
    const gh = fakeQueue();
    await publishWebhookEvent({ WH_GITHUB: gh.q as never }, {
      type: "webhook.received",
      version: 1,
      id: "wh_1",
      source: "github",
      externalId: "gh-1",
      eventKind: "push",
      receivedAt: "2026-08-09T00:00:00Z",
      requestId: "req_1",
      headers: {},
      payload: null,
      r2Key: null,
    });
    expect(gh.sent).toHaveLength(1);
  });
});
