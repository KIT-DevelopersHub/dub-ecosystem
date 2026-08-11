// Free-tier producer fallback. When AUDIT_QUEUE is absent (free plan) publishAudit is
// handed the outboxQueue shim, so a push delivery-failure audit is durably INSERTed into
// freeq_outbox (pending) instead of dropped — the drain forwards it later. The stored row
// is the exact AuditRecordEnvelopeV1 publishAudit builds (its id is the idempotency key).
import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { publishAudit } from "@dub/events";
import type { auditLog } from "@dub/types";
import { AUDIT_TOPIC, outboxQueue } from "../src/outbox";
import { makeD1 } from "./d1";

const input: auditLog.AuditRecordInput = {
  action: "mobile.push.delivery_failed",
  actorId: null,
  orgId: "org_devhub",
  result: "failure",
  resourceType: "notification",
  resourceId: "mntf_1",
  details: { deviceId: "mdev_1", platform: "ios", attempts: 3, lastError: "provider 500" },
  requestId: "req_1",
  occurredAt: "2026-08-11T00:00:00.000Z",
};

describe("outboxQueue producer fallback (audit)", () => {
  it("publishAudit -> shim durably INSERTs a pending audit.record row", async () => {
    const { d1, raw } = makeD1();
    // Exactly what deps.buildDeps does when env.AUDIT_QUEUE is undefined.
    await publishAudit({ AUDIT_QUEUE: outboxQueue(d1 as D1Database, AUDIT_TOPIC) }, input);

    const row = raw.prepare("SELECT topic, status, payload FROM freeq_outbox").get() as
      | { topic: string; status: string; payload: string }
      | undefined;
    expect(row?.topic).toBe(AUDIT_TOPIC);
    expect(row?.status).toBe("pending");
    const env = JSON.parse(row!.payload) as { type: string; version: number; id: string; payload: auditLog.AuditRecordInput };
    expect(env.type).toBe("audit.record");
    expect(env.version).toBe(1);
    expect(typeof env.id).toBe("string");
    expect(env.payload.action).toBe("mobile.push.delivery_failed");
    expect(env.payload.resourceId).toBe("mntf_1");
  });

  it("send is a plain enqueue: two rows for two sends (at-least-once outbox)", async () => {
    const { d1, raw } = makeD1();
    const q = outboxQueue<{ n: number }>(d1 as D1Database, AUDIT_TOPIC);
    await q.send({ n: 1 });
    await q.send({ n: 2 });
    const count = raw.prepare("SELECT COUNT(*) AS c FROM freeq_outbox").get() as { c: number };
    expect(count.c).toBe(2);
  });
});
