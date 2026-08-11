// notification's best-effort delivery-failed audit is Queue-free on the free tier: the
// delivery path resolves its audit producer to the @dub/freeq D1 outbox (OUTBOX_DB) and a
// Cron drain forwards rows to audit-log. These tests prove (1) the free-tier degrade is
// solved — publishAudit durably persists a sanitized record instead of dropping it,
// (2) the drain delivers it verbatim as the AuditRecordEnvelopeV1 audit-log expects and
// never loses it on delivery failure, and (3) with no outbox binding at all the producer
// resolves to null so the delivery path safely skips publish (never throws).
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { publishAudit } from "@dub/events";
import type { auditLog } from "@dub/types";
import { resolveAuditQueue } from "../src/outbox";
import { makeAuditDeliver, runAuditDrain } from "../src/drain";
import type { Env } from "../src/env";
import { makeD1 } from "./d1";
import { fakeAuditQueue } from "./helpers";

/** Build a complete AuditRecordInput fixture (all fields required). */
function auditInput(over: Partial<auditLog.AuditRecordInput> = {}): auditLog.AuditRecordInput {
  return {
    action: "notif.delivery.failed",
    actorId: null,
    orgId: "org_devhub",
    result: "failure",
    resourceType: "notification",
    resourceId: "ntf_1",
    details: null,
    requestId: "req_1",
    occurredAt: "2026-08-11T00:00:00.000Z",
    ...over,
  };
}

interface StoredRow {
  id: string;
  topic: string;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
}
function rows(raw: ReturnType<typeof makeD1>["raw"]): StoredRow[] {
  return raw.prepare("SELECT * FROM freeq_outbox ORDER BY created_at ASC").all() as unknown as StoredRow[];
}

/** A fake audit-log service binding that records envelopes and returns a chosen status. */
function fakeAuditSvc(status = 202): { svc: Fetcher; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const svc = {
    async fetch(_url: string, init?: RequestInit) {
      bodies.push(JSON.parse(String(init?.body ?? "null")));
      return new Response(null, { status });
    },
  } as unknown as Fetcher;
  return { svc, bodies };
}

describe("resolveAuditQueue + publishAudit (free-tier outbox producer)", () => {
  it("durably enqueues a sanitized audit record when only OUTBOX_DB is bound (no Queue)", async () => {
    const { d1, raw } = makeD1();
    const producer = resolveAuditQueue({ OUTBOX_DB: d1 } as unknown as Env);
    expect(producer).not.toBeNull();

    await publishAudit(producer!, auditInput({ details: { channel: "email", token: "super-secret" } }));

    const stored = rows(raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic).toBe("audit.record");
    expect(stored[0]!.status).toBe("pending"); // durable, not dropped
    // The row payload is the full AuditRecordEnvelopeV1 publishAudit built.
    const envelope = JSON.parse(stored[0]!.payload);
    expect(envelope.type).toBe("audit.record");
    expect(envelope.version).toBe(1);
    expect(typeof envelope.id).toBe("string");
    expect(envelope.payload.action).toBe("notif.delivery.failed");
    expect(envelope.payload.details).toEqual({ channel: "email", token: "[REDACTED]" }); // secret redacted
  });

  it("prefers the real (paid) Queue over the outbox when AUDIT_QUEUE is bound", async () => {
    const { d1, raw } = makeD1();
    const audit = fakeAuditQueue();
    const producer = resolveAuditQueue({ AUDIT_QUEUE: audit.AUDIT_QUEUE, OUTBOX_DB: d1 } as unknown as Env);
    await publishAudit(producer!, auditInput());
    expect(audit.sends).toHaveLength(1); // routed to the Queue
    expect(rows(raw)).toHaveLength(0); // ...not the outbox
  });

  it("resolves to null (safe no-op) when neither Queue nor OUTBOX_DB is bound", () => {
    expect(resolveAuditQueue({} as unknown as Env)).toBeNull();
  });
});

describe("audit outbox drain (delivery to audit-log)", () => {
  it("delivers the queued record as an AuditRecordEnvelopeV1 and marks it done", async () => {
    const { d1, raw } = makeD1();
    await publishAudit(resolveAuditQueue({ OUTBOX_DB: d1 } as unknown as Env)!, auditInput());

    const { svc, bodies } = fakeAuditSvc(202);
    const res = await runAuditDrain({ OUTBOX_DB: d1, SVC_AUDIT: svc } as unknown as Env);

    expect(res).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(rows(raw)[0]!.status).toBe("done");

    // envelope shape matches the retired dub-q-audit-record message audit-log parses
    expect(bodies).toHaveLength(1);
    const env0 = bodies[0] as { type: string; version: number; id: string; payload: { action: string } };
    expect(env0.type).toBe("audit.record");
    expect(env0.version).toBe(1);
    expect(typeof env0.id).toBe("string");
    expect(env0.payload.action).toBe("notif.delivery.failed");
  });

  it("keeps the record (pending, not lost) when audit-log rejects the delivery", async () => {
    const { d1, raw } = makeD1();
    await publishAudit(resolveAuditQueue({ OUTBOX_DB: d1 } as unknown as Env)!, auditInput());

    const { svc } = fakeAuditSvc(500);
    const res = await runAuditDrain({ OUTBOX_DB: d1, SVC_AUDIT: svc } as unknown as Env);

    expect(res).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    const r = rows(raw)[0]!;
    expect(r.status).toBe("pending"); // durable — retried later, never dropped
    expect(r.attempts).toBe(1);
    expect(r.last_error).toContain("500");
  });

  it("no-ops when the drain has no outbox DB / audit binding (paid deploy)", async () => {
    const res = await runAuditDrain({} as unknown as Env);
    expect(res).toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
  });
});

describe("makeAuditDeliver", () => {
  it("throws on a non-2xx response so the row is retried", async () => {
    const { svc } = fakeAuditSvc(404);
    const deliver = makeAuditDeliver(svc);
    await expect(
      deliver({ id: "x", topic: "audit.record", payload: { type: "audit.record", version: 1, id: "x", payload: { action: "a" } }, attempts: 1 }),
    ).rejects.toThrow(/404/);
  });

  it("ignores unknown topics (no delivery attempted)", async () => {
    const { svc, bodies } = fakeAuditSvc(500); // would throw if called
    const deliver = makeAuditDeliver(svc);
    await expect(deliver({ id: "x", topic: "other.topic", payload: {}, attempts: 1 })).resolves.toBeUndefined();
    expect(bodies).toHaveLength(0);
  });
});
