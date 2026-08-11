// Free-tier outbox shim + publisher/audit fallback. Verifies that (1) outboxQueue
// send/sendBatch durably INSERT into freeq_outbox, (2) buildPublisherEnv fans a chat.*
// event out to a durable row for its subscriber when the paid Queue binding is absent
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

const ctx = { requestId: "req_1", actorId: "user_author" as string | null };

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
    await outboxQueue<{ n: number }>(d1 as D1Database, eventTopic("notification")).sendBatch([{ body: { n: 1 } }, { body: { n: 2 } }]);
    expect(rows(raw, "evt.notification")).toHaveLength(2);
  });
});

describe("buildPublisherEnv free-tier fan-out (no Queue bindings)", () => {
  it("writes one durable outbox row per subscriber of the chat event", async () => {
    const { d1, raw } = makeD1();
    const pubEnv = buildPublisherEnv(d1 as D1Database, {});
    const envelope = createEvent("chat.message.created", { channelId: "chan_1", messageId: "msg_1", authorId: "user_author" }, ctx);
    await publishEvent(pubEnv, envelope);

    // chat.message.created subscribers => one row each, on their per-consumer topic.
    const expected = SUBSCRIPTIONS["chat.message.created"].map(eventTopic).sort();
    expect(rows(raw).map((r) => r.topic).sort()).toEqual(expected);
    for (const r of rows(raw)) {
      expect(r.status).toBe("pending");
      expect(JSON.parse(r.payload).name).toBe("chat.message.created");
    }
  });

  it("prefers a real Queue binding over the outbox when present", async () => {
    const { d1, raw } = makeD1();
    const sent: DubEventEnvelope[] = [];
    const realNotif = { async send(b: DubEventEnvelope) { sent.push(b); }, async sendBatch() {} } as unknown as Queue<DubEventEnvelope>;
    // chat.channel.created's sole subscriber is notification. Bind it real.
    const pubEnv = buildPublisherEnv(d1 as D1Database, { [CONSUMER_QUEUE_BINDINGS.notification]: realNotif });
    const envelope = createEvent("chat.channel.created", { channelId: "chan_1", name: "general" }, ctx);
    await publishEvent(pubEnv, envelope);

    expect(sent).toHaveLength(1); // notification went to the real Queue
    expect(rows(raw)).toHaveLength(0); // nothing fell back to the outbox
  });
});

describe("audit fallback", () => {
  it("persists the AuditRecordEnvelopeV1 as a durable outbox row", async () => {
    const { d1, raw } = makeD1();
    const auditQueue = outboxQueue<AuditRecordEnvelopeV1>(d1 as D1Database, AUDIT_TOPIC);
    await publishAudit({ AUDIT_QUEUE: auditQueue }, {
      action: "chat.message.create",
      actorId: "user_author",
      orgId: "org_devhub",
      result: "success",
      resourceType: "chat_message",
      resourceId: "msg_1",
      details: null,
      requestId: "req_1",
      occurredAt: "2026-08-11T00:00:00.000Z",
    });
    const [row] = rows(raw, AUDIT_TOPIC);
    expect(row!.status).toBe("pending");
    const env = JSON.parse(row!.payload);
    expect(env.type).toBe("audit.record");
    expect(env.payload.action).toBe("chat.message.create");
  });
});
