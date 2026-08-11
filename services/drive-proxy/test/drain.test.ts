// Free-tier outbox drain. Seeds freeq_outbox via @dub/freeq enqueue, then drains:
// audit.record rows are forwarded to audit-log's /internal/audit-async (verbatim
// AuditRecordEnvelopeV1) and marked done; file-meta domain-event rows are deferred (stay
// pending, never dropped, never done). A non-2xx from audit-log keeps the audit row
// pending. With no OUTBOX_DB (paid plan) the drain is a zeroed no-op.
import { describe, it, expect } from "vitest";
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import { runOutboxDrain } from "../src/drain";
import { AUDIT_TOPIC, TOPIC_FILE_META } from "../src/outbox";
import type { Env } from "../src/env";
import { makeD1 } from "./outbox-d1";

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

function envWith(db: D1Database | undefined, svc?: Fetcher): Env {
  return { OUTBOX_DB: db, SVC_AUDIT: svc } as unknown as Env;
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
    action: "drive.file.create",
    actorId: "usr_alice",
    orgId: "org_devhub",
    result: "success" as const,
    resourceType: "drive_file",
    resourceId: "drivefile_1",
    details: null,
    requestId: "req_1",
    occurredAt: "2026-08-11T00:00:00.000Z",
  },
};

describe("runOutboxDrain", () => {
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

  it("defers file-meta domain-event rows (stay pending, not delivered)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, TOPIC_FILE_META, { name: "drive.file.created", id: "e1" });
    const { svc, calls } = recordingAudit(202);

    const result = await runOutboxDrain(envWith(d1 as D1Database, svc));

    expect(calls).toHaveLength(0); // no consumer route: nothing forwarded
    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1); // rescheduled, still durable
    expect(statusOf(raw, TOPIC_FILE_META)).toBe("pending");
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

  it("is a zeroed no-op when OUTBOX_DB is absent (paid plan)", async () => {
    const result = await runOutboxDrain(envWith(undefined, undefined));
    expect(result).toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
  });
});
