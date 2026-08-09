import { describe, it, expect } from "vitest";
import type { Queue } from "@cloudflare/workers-types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";
import { createEventPublisher } from "../src/events";

function fakeQueue<T>(): Queue<T> & { sent: T[] } {
  const sent: T[] = [];
  return {
    sent,
    async send(m: T) { sent.push(m); },
    async sendBatch(ms: Iterable<{ body: T }>) { for (const m of ms) sent.push(m.body); },
  } as unknown as Queue<T> & { sent: T[] };
}

const ctx = { requestId: "req_42", actorId: "usr_9" };

describe("EventPublisher (real @dub/events integration, test #2)", () => {
  it("routes drive.file.created to EVT_FILE_META as a canonical envelope", async () => {
    const evt = fakeQueue<DubEventEnvelope>();
    const audit = fakeQueue<AuditRecordEnvelopeV1>();
    const pub = createEventPublisher({ EVT_FILE_META: evt, AUDIT_QUEUE: audit });

    await pub.fileCreated(ctx, "drivefile_1");

    expect(evt.sent).toHaveLength(1);
    const env = evt.sent[0]!;
    expect(env.name).toBe("drive.file.created");
    expect(env.version).toBe(1);
    expect(typeof env.id).toBe("string");
    expect(env.id.length).toBeGreaterThan(0);
    expect(env.requestId).toBe("req_42");
    expect(env.actorId).toBe("usr_9");
    expect(env.payload).toEqual({ driveFileId: "drivefile_1" });
  });

  it("emits moved and trashed envelopes", async () => {
    const evt = fakeQueue<DubEventEnvelope>();
    const audit = fakeQueue<AuditRecordEnvelopeV1>();
    const pub = createEventPublisher({ EVT_FILE_META: evt, AUDIT_QUEUE: audit });
    await pub.fileMoved(ctx, "d2");
    await pub.fileTrashed(ctx, "d3");
    expect(evt.sent.map((e) => e.name)).toEqual(["drive.file.moved", "drive.file.trashed"]);
  });

  it("publishes audit records to AUDIT_QUEUE with the canonical audit envelope", async () => {
    const evt = fakeQueue<DubEventEnvelope>();
    const audit = fakeQueue<AuditRecordEnvelopeV1>();
    const pub = createEventPublisher({ EVT_FILE_META: evt, AUDIT_QUEUE: audit });

    await pub.audit(ctx, "drive.file.create", "drivefile_1", { name: "N" });

    expect(audit.sent).toHaveLength(1);
    const rec = audit.sent[0]!;
    expect(rec.type).toBe("audit.record");
    expect(rec.version).toBe(1);
    expect(rec.payload.action).toBe("drive.file.create");
    expect(rec.payload.actorId).toBe("usr_9");
    expect(rec.payload.result).toBe("success");
    expect(rec.payload.resourceType).toBe("drive_file");
    expect(rec.payload.resourceId).toBe("drivefile_1");
    expect(rec.payload.requestId).toBe("req_42");
  });

  it("sheet.write audit does NOT touch the domain event queue", async () => {
    const evt = fakeQueue<DubEventEnvelope>();
    const audit = fakeQueue<AuditRecordEnvelopeV1>();
    const pub = createEventPublisher({ EVT_FILE_META: evt, AUDIT_QUEUE: audit });
    await pub.audit(ctx, "drive.sheet.write", "sheet_1", { mode: "update", range: "A1:B2" });
    expect(evt.sent).toHaveLength(0);
    expect(audit.sent).toHaveLength(1);
  });
});
