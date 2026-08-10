// auth-service audit is Queue-free: the producer INSERTs into the @dub/freeq D1
// outbox and a Cron drain forwards rows to audit-log. These tests prove (1) the
// producer writes a durable, sanitized record and (2) the drain delivers it as the
// AuditRecordEnvelopeV1 audit-log expects — and never loses it on delivery failure.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { OutboxAuditor } from "../src/audit";
import { makeAuditDeliver, runAuditDrain } from "../src/drain";
import type { Env } from "../src/env";
import { makeOutboxD1 } from "./outbox-d1";

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
function fakeAuditSvc(status = 201): { svc: Fetcher; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const svc = {
    async fetch(_url: string, init?: RequestInit) {
      bodies.push(JSON.parse(String(init?.body ?? "null")));
      return new Response(null, { status });
    },
  } as unknown as Fetcher;
  return { svc, bodies };
}

describe("OutboxAuditor (producer INSERT)", () => {
  it("enqueues a durable, org-stamped audit record with secret details redacted", async () => {
    const { d1, raw } = makeOutboxD1();
    const auditor = new OutboxAuditor(d1);

    await auditor.record({
      action: "auth.session.login",
      actorId: "usr_1",
      result: "success",
      requestId: "req_1",
      details: { client: "web", token: "super-secret" },
    });

    const stored = rows(raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic).toBe("audit.record");
    expect(stored[0]!.status).toBe("pending");
    const payload = JSON.parse(stored[0]!.payload);
    expect(payload.action).toBe("auth.session.login");
    expect(payload.actorId).toBe("usr_1");
    expect(payload.orgId).toBe("org_devhub"); // DUB_DEFAULT_ORG_ID
    expect(payload.details).toEqual({ client: "web", token: "[REDACTED]" }); // secret redacted
    expect(typeof payload.occurredAt).toBe("string");
  });

  it("records multiple events without loss", async () => {
    const { d1, raw } = makeOutboxD1();
    const auditor = new OutboxAuditor(d1);
    await auditor.record({ action: "auth.session.login", actorId: "u1", result: "success", requestId: "r1" });
    await auditor.record({ action: "auth.session.logout", actorId: "u1", result: "success", requestId: "r2" });
    expect(rows(raw)).toHaveLength(2);
  });
});

describe("audit outbox drain (delivery to audit-log)", () => {
  it("delivers the queued record as an AuditRecordEnvelopeV1 and marks it done", async () => {
    const { d1, raw } = makeOutboxD1();
    await new OutboxAuditor(d1).record({
      action: "auth.session.login",
      actorId: "usr_1",
      result: "success",
      requestId: "req_1",
      details: { client: "web" },
    });

    const { svc, bodies } = fakeAuditSvc(201);
    const env = { OUTBOX_DB: d1, SVC_AUDIT: svc } as unknown as Env;
    const res = await runAuditDrain(env);

    expect(res).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(rows(raw)[0]!.status).toBe("done");

    // envelope shape matches the old dub-q-audit-record message the consumer parses
    expect(bodies).toHaveLength(1);
    const env0 = bodies[0] as { type: string; version: number; id: string; payload: { action: string } };
    expect(env0.type).toBe("audit.record");
    expect(env0.version).toBe(1);
    expect(typeof env0.id).toBe("string");
    expect(env0.payload.action).toBe("auth.session.login");
    // the delivered id equals the outbox row id (idempotency key)
    expect(env0.id).toBe(rows(raw)[0]!.id);
  });

  it("keeps the record (pending, not lost) when audit-log rejects the delivery", async () => {
    const { d1, raw } = makeOutboxD1();
    await new OutboxAuditor(d1).record({ action: "auth.session.login", actorId: "u1", result: "success", requestId: "r1" });

    const { svc } = fakeAuditSvc(500);
    const env = { OUTBOX_DB: d1, SVC_AUDIT: svc } as unknown as Env;
    const res = await runAuditDrain(env);

    expect(res).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    const r = rows(raw)[0]!;
    expect(r.status).toBe("pending"); // durable — retried later, never dropped
    expect(r.attempts).toBe(1);
    expect(r.last_error).toContain("500");
  });
});

describe("makeAuditDeliver", () => {
  it("throws on a non-2xx response so the row is retried", async () => {
    const { svc } = fakeAuditSvc(404);
    const deliver = makeAuditDeliver(svc);
    await expect(
      deliver({ id: "x", topic: "audit.record", payload: { action: "a" }, attempts: 1 }),
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
