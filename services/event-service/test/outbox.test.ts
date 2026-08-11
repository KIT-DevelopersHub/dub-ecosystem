// Free-tier outbox shim + publisher/audit fallback. Verifies that (1) outboxQueue
// send/sendBatch durably INSERT into freeq_outbox, (2) buildPublisherEnv fans an
// event out to one durable row per subscriber when the paid Queue bindings are absent
// but uses a real Queue binding when present, and (3) the audit fallback persists the
// AuditRecordEnvelopeV1 as a durable row.
import { describe, it, expect } from "vitest";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { createEvent, publishEvent, publishAudit, SUBSCRIPTIONS, CONSUMER_QUEUE_BINDINGS, type DubEventEnvelope, type AuditRecordEnvelopeV1 } from "@dub/events";
import { AUDIT_TOPIC, buildPublisherEnv, eventTopic, outboxQueue } from "../src/outbox";
import { makeD1 } from "./d1";

function rows(raw: ReturnType<typeof makeD1>["raw"], topic?: string) {
  const sql = topic
    ? "SELECT id, topic, payload, status FROM freeq_outbox WHERE topic = ? ORDER BY created_at"
    : "SELECT id, topic, payload, status FROM freeq_outbox ORDER BY created_at";
  const stmt = raw.prepare(sql);
  return (topic ? stmt.all(topic) : stmt.all()) as Array<{ id: string; topic: string; payload: string; status: string }>;
}

const ctx = { requestId: "req_1", actorId: "user_caller" as string | null };

describe("outboxQueue (freeq D1 shim)", () => {
  it("send() appends a pending row with topic + JSON payload", async () => {
    const { d1, raw } = makeD1();
    await outboxQueue<{ hello: string }>(d1 as D1Database, eventTopic("notification")).send({ hello: "world" });
    const [row] = rows(raw, "evt.notification");
    expect(row!.status).toBe("pending");
    expect(JSON.parse(row!.payload)).toEqual({ hello: "world" });
  });

  it("sendBatch() appends one row per message", async () => {
    const { d1, raw } = makeD1();
    await outboxQueue<{ n: number }>(d1 as D1Database, eventTopic("task")).sendBatch([{ body: { n: 1 } }, { body: { n: 2 } }]);
    expect(rows(raw, "evt.task")).toHaveLength(2);
  });
});

describe("buildPublisherEnv free-tier fan-out (no Queue bindings)", () => {
  it("writes one durable outbox row per subscriber of the event", async () => {
    const { d1, raw } = makeD1();
    const pubEnv = buildPublisherEnv(d1 as D1Database, {});
    const envelope = createEvent("event.created", { eventId: "event_1", title: "Kickoff", phase: "planning" }, ctx);
    await publishEvent(pubEnv, envelope);

    // event.created subscribers => one row each, on their per-consumer topic.
    const expected = SUBSCRIPTIONS["event.created"].map(eventTopic).sort();
    expect(rows(raw).map((r) => r.topic).sort()).toEqual(expected);
    for (const r of rows(raw)) {
      expect(r.status).toBe("pending");
      expect(JSON.parse(r.payload).name).toBe("event.created");
    }
  });

  it("prefers a real Queue binding over the outbox when present", async () => {
    const { d1, raw } = makeD1();
    const sent: DubEventEnvelope[] = [];
    const realNotif = { async send(b: DubEventEnvelope) { sent.push(b); }, async sendBatch() {} } as unknown as Queue<DubEventEnvelope>;
    // event.updated subscribers: notification, gantt, mobile-bff. Bind only notification.
    const pubEnv = buildPublisherEnv(d1 as D1Database, { [CONSUMER_QUEUE_BINDINGS.notification]: realNotif });
    const envelope = createEvent("event.updated", { eventId: "event_1", changed: ["title"] }, ctx);
    await publishEvent(pubEnv, envelope);

    expect(sent).toHaveLength(1); // notification went to the real Queue
    // gantt + mobile-bff fell back to the outbox; notification did NOT.
    const topics = rows(raw).map((r) => r.topic).sort();
    expect(topics).toEqual([eventTopic("gantt"), eventTopic("mobile-bff")].sort());
  });
});

describe("audit fallback", () => {
  it("persists the AuditRecordEnvelopeV1 as a durable outbox row", async () => {
    const { d1, raw } = makeD1();
    const auditQueue = outboxQueue<AuditRecordEnvelopeV1>(d1 as D1Database, AUDIT_TOPIC);
    await publishAudit({ AUDIT_QUEUE: auditQueue }, {
      action: "event.create",
      actorId: "user_caller",
      orgId: "org_devhub",
      result: "success",
      resourceType: "event",
      resourceId: "event_1",
      details: null,
      requestId: "req_1",
      occurredAt: "2026-08-11T00:00:00.000Z",
    });
    const [row] = rows(raw, AUDIT_TOPIC);
    expect(row!.status).toBe("pending");
    const env = JSON.parse(row!.payload);
    expect(env.type).toBe("audit.record");
    expect(env.payload.action).toBe("event.create");
  });
});
