// Free-tier outbox drain. Seeds freeq_outbox via @dub/freeq enqueue, then drains:
// audit.record rows are forwarded to audit-log's /internal/audit-async (verbatim
// AuditRecordEnvelopeV1) and marked done; domain-event rows are deferred (stay pending,
// never dropped, never done). A non-2xx from audit-log keeps the audit row pending.
import { describe, it, expect } from "vitest";
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import { runOutboxDrain } from "../src/drain";
import { AUDIT_TOPIC, eventTopic } from "../src/outbox";
import type { Env } from "../src/env";
import { makeD1 } from "./d1";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function recordingAudit(status = 202): { svc: Fetcher; calls: Captured[] } {
  const calls: Captured[] = [];
  const svc = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = new Request(input as RequestInfo, init);
      calls.push({
        url: req.url,
        headers: Object.fromEntries(req.headers),
        body: await req.json().catch(() => null),
      });
      return new Response(status === 202 ? '{"id":"ok"}' : "err", { status });
    },
  } as unknown as Fetcher;
  return { svc, calls };
}

function envWith(d1: D1Database, svc?: Fetcher): Env {
  return { DB: d1, SVC_AUDIT: svc } as unknown as Env;
}

function statusOf(raw: ReturnType<typeof makeD1>["raw"], topic: string): string {
  const r = raw.prepare("SELECT status FROM freeq_outbox WHERE topic = ?").get(topic) as { status: string } | undefined;
  return r?.status ?? "(none)";
}

const auditEnvelope = {
  type: "audit.record" as const,
  version: 1 as const,
  id: "aud_env_1",
  payload: {
    action: "event.create",
    actorId: "user_caller",
    orgId: "org_devhub",
    result: "success" as const,
    resourceType: "event",
    resourceId: "event_1",
    details: { requester: "user_caller" },
    requestId: "req_1",
    occurredAt: "2026-08-11T00:00:00.000Z",
  },
};

describe("runOutboxDrain (event-service)", () => {
  it("forwards audit.record to audit-log /internal/audit-async and marks it done", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, auditEnvelope);
    const { svc, calls } = recordingAudit(202);

    const result = await runOutboxDrain(envWith(d1 as D1Database, svc));

    expect(result.delivered).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://audit-log/internal/audit-async");
    expect(calls[0]!.headers["x-dub-internal"]).toBe("1");
    expect(calls[0]!.body).toEqual(auditEnvelope); // forwarded verbatim
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("done");
  });

  it("defers domain-event rows (stay pending, not delivered)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, eventTopic("notification"), { name: "event.created", id: "e1" });
    await enqueue(d1 as D1Database, eventTopic("task"), { name: "event.phase_changed", id: "e2" });
    const { svc, calls } = recordingAudit(202);

    const result = await runOutboxDrain(envWith(d1 as D1Database, svc));

    expect(calls).toHaveLength(0); // no consumer route: nothing forwarded
    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(2); // rescheduled, still durable
    expect(statusOf(raw, eventTopic("notification"))).toBe("pending");
    expect(statusOf(raw, eventTopic("task"))).toBe("pending");
  });

  it("keeps the audit row pending when audit-log returns a non-2xx (retry, never lost)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, auditEnvelope);
    const { svc } = recordingAudit(500);

    const result = await runOutboxDrain(envWith(d1 as D1Database, svc));

    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1);
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("pending");
  });

  it("defers audit too when no SVC_AUDIT binding is present (row retained)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, auditEnvelope);

    const result = await runOutboxDrain(envWith(d1 as D1Database, undefined));

    expect(result.delivered).toBe(0);
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("pending");
  });
});
