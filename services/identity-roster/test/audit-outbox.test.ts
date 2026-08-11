// identity-roster's best-effort audit is Queue-free on the free tier: the publish sink
// INSERTs into the @dub/freeq D1 outbox (OUTBOX_DB) and a Cron drain forwards rows to
// audit-log. These tests prove (1) the free-tier degrade is solved — publish durably
// persists a sanitized record instead of dropping it, (2) the drain delivers it as the
// AuditRecordEnvelopeV1 audit-log expects and never loses it on delivery failure, and
// (3) with no outbox binding at all publish is still a safe no-op (never throws).
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { auditLog } from "@dub/types";
import { createAuditSink } from "../src/sinks";
import { makeAuditDeliver, runAuditDrain } from "../src/drain";
import type { Env } from "../src/env";
import { makeOutboxD1 } from "./outbox-d1";

/** Build a complete AuditRecordInput fixture (all fields are required). */
function auditInput(over: Partial<auditLog.AuditRecordInput> = {}): auditLog.AuditRecordInput {
  return {
    action: "identity.user.suspend",
    actorId: "usr_admin",
    orgId: "org_devhub",
    result: "success",
    resourceType: "user",
    resourceId: "usr_target",
    details: null,
    requestId: "req_1",
    occurredAt: "2026-08-09T00:00:00.000Z",
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
function rows(raw: ReturnType<typeof makeOutboxD1>["raw"]): StoredRow[] {
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

describe("createAuditSink.publish (free-tier outbox producer)", () => {
  it("durably enqueues a sanitized audit record when only OUTBOX_DB is bound (no Queue)", async () => {
    const { d1, raw } = makeOutboxD1();
    const sink = createAuditSink({ OUTBOX_DB: d1 } as unknown as Env);

    await sink.publish(auditInput({ details: { reason: "policy", token: "super-secret" } }));

    const stored = rows(raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic).toBe("audit.record");
    expect(stored[0]!.status).toBe("pending"); // durable, not dropped
    // The row payload is the full AuditRecordEnvelopeV1 publishAudit built.
    const envelope = JSON.parse(stored[0]!.payload);
    expect(envelope.type).toBe("audit.record");
    expect(envelope.version).toBe(1);
    expect(typeof envelope.id).toBe("string");
    expect(envelope.payload.action).toBe("identity.user.suspend");
    expect(envelope.payload.details).toEqual({ reason: "policy", token: "[REDACTED]" }); // secret redacted
  });

  it("is a safe no-op (never throws, nothing enqueued) when neither Queue nor OUTBOX_DB is bound", async () => {
    const sink = createAuditSink({} as unknown as Env);
    await expect(
      sink.publish(auditInput({ action: "identity.role.assign", actorId: "u1", requestId: "r1" })),
    ).resolves.toBeUndefined();
  });
});

describe("audit outbox drain (delivery to audit-log)", () => {
  it("delivers the queued record as an AuditRecordEnvelopeV1 and marks it done", async () => {
    const { d1, raw } = makeOutboxD1();
    await createAuditSink({ OUTBOX_DB: d1 } as unknown as Env).publish(auditInput());

    const { svc, bodies } = fakeAuditSvc(202);
    const res = await runAuditDrain({ OUTBOX_DB: d1, SVC_AUDIT: svc } as unknown as Env);

    expect(res).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(rows(raw)[0]!.status).toBe("done");

    // envelope shape matches the old dub-q-audit-record message audit-log parses
    expect(bodies).toHaveLength(1);
    const env0 = bodies[0] as { type: string; version: number; id: string; payload: { action: string } };
    expect(env0.type).toBe("audit.record");
    expect(env0.version).toBe(1);
    expect(typeof env0.id).toBe("string");
    expect(env0.payload.action).toBe("identity.user.suspend");
  });

  it("keeps the record (pending, not lost) when audit-log rejects the delivery", async () => {
    const { d1, raw } = makeOutboxD1();
    await createAuditSink({ OUTBOX_DB: d1 } as unknown as Env).publish(auditInput({ actorId: "u1", requestId: "r1" }));

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
    await expect(
      deliver({ id: "x", topic: "other.topic", payload: {}, attempts: 1 }),
    ).resolves.toBeUndefined();
    expect(bodies).toHaveLength(0);
  });
});
