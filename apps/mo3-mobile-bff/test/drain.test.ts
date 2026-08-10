// Free-tier audit outbox drain. Seeds freeq_outbox via @dub/freeq enqueue, then drains:
// audit.record rows are forwarded to audit-log's /internal/audit-async (verbatim
// AuditRecordEnvelopeV1) and marked done. A non-2xx from audit-log keeps the row pending
// (retried, never lost); a missing SVC_AUDIT binding defers the row (stays pending too).
import { describe, it, expect } from "vitest";
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import { runOutboxDrain } from "../src/drain";
import { AUDIT_TOPIC } from "../src/outbox";
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
      calls.push({ url: req.url, headers: Object.fromEntries(req.headers), body: await req.json().catch(() => null) });
      return new Response(status === 202 ? '{"id":"ok"}' : "err", { status });
    },
  } as unknown as Fetcher;
  return { svc, calls };
}

function envWith(d1: D1Database, svc?: Fetcher): Env {
  return { DB_MOBILE: d1, SVC_AUDIT: svc } as unknown as Env;
}

function statusOf(raw: ReturnType<typeof makeD1>["raw"], topic: string): string {
  const r = raw.prepare("SELECT status FROM freeq_outbox WHERE topic = ?").get(topic) as { status: string } | undefined;
  return r?.status ?? "(none)";
}

// The exact AuditRecordEnvelopeV1 publishAudit builds for a push delivery-failure (D3).
const auditEnvelope = {
  type: "audit.record" as const,
  version: 1 as const,
  id: "aud_env_1",
  payload: {
    action: "mobile.push.delivery_failed",
    actorId: null,
    orgId: "org_devhub",
    result: "failure" as const,
    resourceType: "notification",
    resourceId: "mntf_1",
    details: { notificationId: "mntf_1", deviceId: "mdev_1", platform: "ios", attempts: 3, lastError: "provider 500" },
    requestId: "req_1",
    occurredAt: "2026-08-11T00:00:00.000Z",
  },
};

describe("runOutboxDrain (mobile-bff audit outbox)", () => {
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

  it("keeps the row pending when audit-log returns a non-2xx (retry, never lost)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, auditEnvelope);
    const { svc } = recordingAudit(500);

    const result = await runOutboxDrain(envWith(d1 as D1Database, svc));

    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1);
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("pending");
  });

  it("defers audit when no SVC_AUDIT binding is present (row retained pending)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, auditEnvelope);

    const result = await runOutboxDrain(envWith(d1 as D1Database, undefined));

    expect(result.delivered).toBe(0);
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("pending");
  });
});
