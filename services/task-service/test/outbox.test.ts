// task-service is Queue-free on the Workers FREE plan: the producers INSERT into the
// @dub/freeq D1 outbox and a Cron drain forwards rows to their real consumers. These
// tests prove (1) buildPublisherEnv / buildAuditEnv prefer a real Queue when present but
// fall back to the outbox shim when absent, (2) the shim writes durable rows on the right
// topics (task.* fan-out + sanitized audit), and (3) the drain delivers audit rows to
// audit-log and defers domain events without ever losing a row.
import { describe, it, expect } from "vitest";
import type { Fetcher, Queue } from "@cloudflare/workers-types";
import { createEvent, type DubEventEnvelope } from "@dub/events";
import {
  buildPublisherEnv,
  buildAuditEnv,
  createQueueEventPublisher,
  createQueueAuditor,
} from "../src/events";
import { makeOutboxDeliver, runOutboxDrain } from "../src/drain";
import { AUDIT_TOPIC, TOPIC_NOTIFICATION } from "../src/outbox";
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
  return raw.prepare("SELECT * FROM freeq_outbox ORDER BY created_at ASC, id ASC").all() as unknown as StoredRow[];
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

describe("buildPublisherEnv / buildAuditEnv (binding-presence fallback)", () => {
  it("falls back to the freeq outbox shim when no Queue bindings are present", async () => {
    const { d1, raw } = makeOutboxD1();
    const env = { DB: d1 } as unknown as Env;
    const publisher = createQueueEventPublisher(buildPublisherEnv(env));

    // task.created fans out to notification / github-sync / gantt / mobile-bff (4 lanes).
    const ev = createEvent("task.created", { taskId: "task_1", eventId: "evt_1" }, { requestId: "r", actorId: "usr_1" });
    await publisher.publish([ev]);

    const stored = rows(raw);
    // one row per subscriber lane, all pending, all carrying the same envelope id.
    expect(stored.length).toBe(4);
    expect(new Set(stored.map((r) => r.topic))).toEqual(
      new Set(["evt.notification", "evt.github-sync", "evt.gantt", "evt.mobile-bff"]),
    );
    for (const r of stored) {
      expect(r.status).toBe("pending");
      expect(JSON.parse(r.payload).id).toBe(ev.id);
    }
  });

  it("prefers a real Queue binding over the outbox when present", async () => {
    const { d1, raw } = makeOutboxD1();
    const sent: DubEventEnvelope[] = [];
    const fakeQueue = {
      async send(b: DubEventEnvelope) {
        sent.push(b);
      },
      async sendBatch(batch: Iterable<{ body: DubEventEnvelope }>) {
        for (const m of batch) sent.push(m.body);
      },
    } as unknown as Queue<DubEventEnvelope>;
    // Every task.* subscriber lane bound to the same real queue -> nothing hits the outbox.
    const env = {
      DB: d1,
      EVT_NOTIFICATION: fakeQueue,
      EVT_GITHUB_SYNC: fakeQueue,
      EVT_GANTT: fakeQueue,
      EVT_MOBILE_BFF: fakeQueue,
      EVT_FILE_META: fakeQueue,
    } as unknown as Env;
    const publisher = createQueueEventPublisher(buildPublisherEnv(env));

    const ev = createEvent("task.created", { taskId: "task_1", eventId: "evt_1" }, { requestId: "r", actorId: "usr_1" });
    await publisher.publish([ev]);

    expect(sent.length).toBe(4); // 4 real-queue sends
    expect(rows(raw)).toHaveLength(0); // outbox untouched
  });

  it("audit falls back to the outbox and redacts secrets", async () => {
    const { d1, raw } = makeOutboxD1();
    const env = { DB: d1 } as unknown as Env;
    const auditor = createQueueAuditor(buildAuditEnv(env));

    await auditor.record({
      action: "task.task.archived",
      actorId: "usr_1",
      orgId: "org_devhub",
      result: "success",
      resourceType: "task",
      resourceId: "task_1",
      details: { eventId: "evt_1", token: "super-secret" },
      requestId: "req_1",
      occurredAt: new Date().toISOString(),
    });

    const stored = rows(raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic).toBe(AUDIT_TOPIC);
    expect(stored[0]!.status).toBe("pending");
    const payload = JSON.parse(stored[0]!.payload).payload; // AuditRecordEnvelopeV1.payload
    expect(payload.action).toBe("task.task.archived");
    expect(payload.details).toEqual({ eventId: "evt_1", token: "[REDACTED]" });
  });
});

describe("outbox drain (delivery to audit-log)", () => {
  it("delivers a queued audit row as the AuditRecordEnvelopeV1 and marks it done", async () => {
    const { d1, raw } = makeOutboxD1();
    await createQueueAuditor(buildAuditEnv({ DB: d1 } as unknown as Env)).record({
      action: "task.dependency.replaced",
      actorId: "usr_1",
      orgId: "org_devhub",
      result: "success",
      resourceType: "task",
      resourceId: "task_1",
      details: { eventId: "evt_1" },
      requestId: "req_1",
      occurredAt: new Date().toISOString(),
    });

    const { svc, bodies } = fakeAuditSvc(202);
    const env = { DB: d1, SVC_AUDIT: svc } as unknown as Env;
    const res = await runOutboxDrain(env);

    expect(res).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(rows(raw)[0]!.status).toBe("done");

    expect(bodies).toHaveLength(1);
    const env0 = bodies[0] as { type: string; version: number; id: string; payload: { action: string } };
    expect(env0.type).toBe("audit.record");
    expect(env0.version).toBe(1);
    expect(env0.payload.action).toBe("task.dependency.replaced");
  });

  it("keeps an audit row pending (not lost) when audit-log rejects the delivery", async () => {
    const { d1, raw } = makeOutboxD1();
    await createQueueAuditor(buildAuditEnv({ DB: d1 } as unknown as Env)).record({
      action: "task.task.archived",
      actorId: "u1",
      orgId: "org_devhub",
      result: "success",
      resourceType: "task",
      resourceId: "task_1",
      details: null,
      requestId: "r1",
      occurredAt: new Date().toISOString(),
    });

    const { svc } = fakeAuditSvc(500);
    const env = { DB: d1, SVC_AUDIT: svc } as unknown as Env;
    const res = await runOutboxDrain(env);

    expect(res).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    const r = rows(raw)[0]!;
    expect(r.status).toBe("pending"); // durable — retried later, never dropped
    expect(r.last_error).toContain("500");
  });

  it("defers domain-event rows (kept pending) — no free-tier consumer route from here", async () => {
    const { d1, raw } = makeOutboxD1();
    const publisher = createQueueEventPublisher(buildPublisherEnv({ DB: d1 } as unknown as Env));
    // task.due_soon fans out to notification + mobile-bff (2 evt.* lanes, no audit).
    await publisher.publish([
      createEvent("task.due_soon", { taskId: "task_1", eventId: "evt_1", dueAt: "2026-08-12T00:00:00Z" }, { requestId: "r", actorId: null }),
    ]);

    const { svc, bodies } = fakeAuditSvc(500); // would throw if audit path were hit
    const env = { DB: d1, SVC_AUDIT: svc } as unknown as Env;
    const res = await runOutboxDrain(env);

    expect(res).toMatchObject({ delivered: 0, retried: 2, failed: 0 }); // both deferred (retry, not fail)
    expect(bodies).toHaveLength(0); // audit-log never called for evt.* topics
    for (const r of rows(raw)) expect(r.status).toBe("pending"); // durable/pending, never dropped
  });
});

describe("makeOutboxDeliver", () => {
  it("defers audit when SVC_AUDIT is absent (row stays pending)", async () => {
    const deliver = makeOutboxDeliver({ DB: undefined } as unknown as Env);
    await expect(deliver({ id: "x", topic: AUDIT_TOPIC, payload: {}, attempts: 1 })).rejects.toThrow(/retained pending/);
  });

  it("defers a domain-event topic (row stays pending)", async () => {
    const { svc } = fakeAuditSvc(500);
    const deliver = makeOutboxDeliver({ SVC_AUDIT: svc } as unknown as Env);
    await expect(deliver({ id: "x", topic: TOPIC_NOTIFICATION, payload: {}, attempts: 1 })).rejects.toThrow(/retained pending/);
  });

  it("acks an unknown topic (nothing to deliver)", async () => {
    const { svc } = fakeAuditSvc(500);
    const deliver = makeOutboxDeliver({ SVC_AUDIT: svc } as unknown as Env);
    await expect(deliver({ id: "x", topic: "other.topic", payload: {}, attempts: 1 })).resolves.toBeUndefined();
  });
});
