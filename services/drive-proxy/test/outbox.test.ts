// Free-tier outbox shim + buildPublisherEnv fallback. Verifies that (1) outboxQueue
// send/sendBatch durably INSERT into freeq_outbox, and (2) when the paid Queue bindings
// are absent, buildPublisherEnv routes the @dub/events publishers through the freeq
// outbox so createEventPublisher persists file-meta events + audit records as durable
// rows — never dropped. When the Queue bindings ARE present they are used unchanged.
import { describe, it, expect } from "vitest";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { createEventPublisher } from "../src/events";
import { AUDIT_TOPIC, TOPIC_FILE_META, buildPublisherEnv, outboxQueue } from "../src/outbox";
import type { Env } from "../src/env";
import { makeD1 } from "./outbox-d1";

function rows(raw: ReturnType<typeof makeD1>["raw"], topic?: string) {
  const sql = topic
    ? "SELECT id, topic, payload, status FROM freeq_outbox WHERE topic = ? ORDER BY created_at"
    : "SELECT id, topic, payload, status FROM freeq_outbox ORDER BY created_at";
  const stmt = raw.prepare(sql);
  return (topic ? stmt.all(topic) : stmt.all()) as Array<{ id: string; topic: string; payload: string; status: string }>;
}

const ctx = { requestId: "req_42", actorId: "usr_9" };

describe("outboxQueue (freeq D1 shim)", () => {
  it("send() appends a pending row with topic + JSON payload", async () => {
    const { d1, raw } = makeD1();
    await outboxQueue<{ hello: string }>(d1 as D1Database, TOPIC_FILE_META).send({ hello: "world" });
    const [row] = rows(raw, TOPIC_FILE_META);
    expect(row!.status).toBe("pending");
    expect(JSON.parse(row!.payload)).toEqual({ hello: "world" });
  });

  it("sendBatch() appends one row per message", async () => {
    const { d1, raw } = makeD1();
    await outboxQueue<{ n: number }>(d1 as D1Database, TOPIC_FILE_META).sendBatch([{ body: { n: 1 } }, { body: { n: 2 } }]);
    expect(rows(raw, TOPIC_FILE_META)).toHaveLength(2);
  });
});

describe("buildPublisherEnv free-tier fallback (no Queue bindings)", () => {
  it("persists file-meta event + audit as durable outbox rows via createEventPublisher", async () => {
    const { d1, raw } = makeD1();
    // No EVT_FILE_META / AUDIT_QUEUE bindings; only OUTBOX_DB -> forces the outbox shim.
    const env = { OUTBOX_DB: d1 as D1Database } as unknown as Env;
    const pub = createEventPublisher(buildPublisherEnv(env));

    await pub.fileCreated(ctx, "drivefile_1");
    await pub.audit(ctx, "drive.file.create", "drivefile_1", { name: "N" });

    // drive.file.created -> file-meta consumer topic (canonical DubEventEnvelope stored).
    const evt = rows(raw, TOPIC_FILE_META);
    expect(evt).toHaveLength(1);
    const evtEnvelope = JSON.parse(evt[0]!.payload);
    expect(evtEnvelope.name).toBe("drive.file.created");
    expect(evtEnvelope.payload).toEqual({ driveFileId: "drivefile_1" });

    // audit -> AuditRecordEnvelopeV1 stored verbatim under the audit.record topic.
    const audit = rows(raw, AUDIT_TOPIC);
    expect(audit).toHaveLength(1);
    const auditEnvelope = JSON.parse(audit[0]!.payload);
    expect(auditEnvelope.type).toBe("audit.record");
    expect(auditEnvelope.payload.action).toBe("drive.file.create");
    expect(auditEnvelope.payload.result).toBe("success");
    expect(auditEnvelope.payload.resourceId).toBe("drivefile_1");
  });
});

describe("buildPublisherEnv paid path (Queue bindings present)", () => {
  it("uses the real Queue bindings and never touches OUTBOX_DB", async () => {
    const sent: Array<{ q: string; body: unknown }> = [];
    const fakeQueue = (q: string): Queue<unknown> =>
      ({ async send(b: unknown) { sent.push({ q, body: b }); } }) as unknown as Queue<unknown>;
    const { d1, raw } = makeD1();
    const env = {
      EVT_FILE_META: fakeQueue("EVT_FILE_META"),
      AUDIT_QUEUE: fakeQueue("AUDIT_QUEUE"),
      OUTBOX_DB: d1 as D1Database,
    } as unknown as Env;

    const pub = createEventPublisher(buildPublisherEnv(env));
    await pub.fileMoved(ctx, "d2");
    await pub.audit(ctx, "drive.file.move", "d2");

    expect(sent.map((s) => s.q)).toEqual(["EVT_FILE_META", "AUDIT_QUEUE"]);
    expect(rows(raw)).toHaveLength(0); // outbox untouched on the paid path
  });
});
