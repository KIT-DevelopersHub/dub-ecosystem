// 改善#5: the free-tier /internal/events-async landing route. Proves a freeq-delivered
// mail.message.received envelope reaches the auto-reply pipeline (previously the topic sat
// pending forever, so nothing fired), with idempotency + poison/retry semantics.
import { describe, it, expect } from "vitest";
import type { DubEventEnvelope } from "@dub/events";
import { dispatchEnvelope, handleEventsAsync } from "../src/events-async";
import { makeDeps, inbound } from "./fakes";

function receivedEvent(over: Partial<DubEventEnvelope> = {}): DubEventEnvelope {
  return {
    name: "mail.message.received",
    version: 1,
    id: "evt_1",
    occurredAt: "2026-08-09T10:00:00.000Z",
    requestId: "req_1",
    actorId: null,
    payload: { messageId: "<m@x>", threadId: "thread_x" },
    ...over,
  } as DubEventEnvelope;
}

function req(body: unknown): Request {
  return new Request("https://mail-automation/internal/events-async", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleEventsAsync (free-tier freeq landing)", () => {
  it("runs the auto-reply pipeline for a delivered mail.message.received (改善#5)", async () => {
    const b = makeDeps({ messages: { "<m@x>": inbound({ messageId: "<m@x>", threadId: "thread_x" }) } });
    const res = await handleEventsAsync(req(receivedEvent()), { repo: b.repo, pipeline: b.deps });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    // The pipeline actually ran (a decision was emitted) — the topic no longer sits pending.
    expect(b.publisher.decided).toHaveLength(1);
  });

  it("is idempotent: a redelivered envelope is a no-op (duplicate)", async () => {
    const b = makeDeps({ messages: { "<m@x>": inbound({ messageId: "<m@x>", threadId: "thread_x" }) } });
    await handleEventsAsync(req(receivedEvent()), { repo: b.repo, pipeline: b.deps });
    const second = await handleEventsAsync(req(receivedEvent()), { repo: b.repo, pipeline: b.deps });
    expect(await second.json()).toEqual({ status: "duplicate" });
    expect(b.publisher.decided).toHaveLength(1); // not processed twice
  });

  it("acks an event this service does not subscribe to (unknown, forward-compat)", async () => {
    const b = makeDeps();
    const res = await handleEventsAsync(req(receivedEvent({ name: "task.created" })), { repo: b.repo, pipeline: b.deps });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unknown" });
    expect(b.publisher.decided).toHaveLength(0);
  });

  it("400s a malformed envelope (acked so it cannot loop forever)", async () => {
    const b = makeDeps();
    expect((await handleEventsAsync(req("not json"), { repo: b.repo, pipeline: b.deps })).status).toBe(400);
    expect((await handleEventsAsync(req({ id: "x" }), { repo: b.repo, pipeline: b.deps })).status).toBe(400);
  });

  it("500s on a handler failure so the drain RETRIES (never a silent drop)", async () => {
    // No message on the gateway -> getMessage throws -> handler failure -> 500.
    const b = makeDeps({ messages: {} });
    const res = await handleEventsAsync(req(receivedEvent()), { repo: b.repo, pipeline: b.deps });
    expect(res.status).toBe(500);
  });

  it("dispatchEnvelope reports duplicate on a second call (event id dedup)", async () => {
    const b = makeDeps({ messages: { "<m@x>": inbound({ messageId: "<m@x>", threadId: "thread_x" }) } });
    expect(await dispatchEnvelope(b.repo, b.deps, receivedEvent())).toBe("ok");
    expect(await dispatchEnvelope(b.repo, b.deps, receivedEvent())).toBe("duplicate");
  });
});
