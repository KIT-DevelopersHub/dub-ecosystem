// Free-tier producer conversion (theme: retire the AUDIT_QUEUE Cloudflare Queue).
// The outboxQueue shim enqueues publishAudit's AuditRecordEnvelopeV1 into freeq_outbox,
// and runOutboxDrain forwards audit.record rows to audit-log's /internal/audit-async
// (verbatim envelope), marking them done. A non-2xx / missing binding keeps the row
// pending (durable, never dropped).
import { describe, it, expect } from "vitest";
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import { publishAudit, type AuditRecordEnvelopeV1 } from "@dub/events";
import { runOutboxDrain } from "../src/drain";
import { AUDIT_TOPIC, outboxQueue } from "../src/outbox";
import type { Env } from "../src";
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
  return { DB: d1, SVC_AUDIT: svc } as unknown as Env;
}

function statusOf(raw: ReturnType<typeof makeD1>["raw"], topic: string): string {
  const r = raw.prepare("SELECT status FROM freeq_outbox WHERE topic = ?").get(topic) as { status: string } | undefined;
  return r?.status ?? "(none)";
}

describe("outboxQueue shim (publishAudit fallback)", () => {
  it("publishAudit through the shim durably persists an AuditRecordEnvelopeV1 row", async () => {
    const { d1, raw } = makeD1();
    const auditEnv = { AUDIT_QUEUE: outboxQueue<AuditRecordEnvelopeV1>(d1 as D1Database, AUDIT_TOPIC) };
    await publishAudit(auditEnv, {
      action: "file.meta.registered",
      actorId: "usr_alice",
      orgId: "org_devhub",
      result: "success",
      resourceType: "file",
      resourceId: "file_1",
      details: null,
      requestId: "req_1",
      occurredAt: "2026-08-11T00:00:00.000Z",
    });
    const row = raw.prepare("SELECT topic, status, payload FROM freeq_outbox").get() as { topic: string; status: string; payload: string };
    expect(row.topic).toBe(AUDIT_TOPIC);
    expect(row.status).toBe("pending");
    const env = JSON.parse(row.payload) as AuditRecordEnvelopeV1;
    expect(env.type).toBe("audit.record");
    expect(env.payload.action).toBe("file.meta.registered");
  });
});

describe("runOutboxDrain", () => {
  const envelope: AuditRecordEnvelopeV1 = {
    type: "audit.record",
    version: 1,
    id: "aud_env_1",
    payload: {
      action: "file.meta.registered",
      actorId: "usr_alice",
      orgId: "org_devhub",
      result: "success",
      resourceType: "file",
      resourceId: "file_1",
      details: null,
      requestId: "req_1",
      occurredAt: "2026-08-11T00:00:00.000Z",
    },
  };

  it("forwards audit.record to audit-log /internal/audit-async and marks it done", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, envelope);
    const { svc, calls } = recordingAudit(202);

    const result = await runOutboxDrain(envWith(d1 as D1Database, svc));

    expect(result.delivered).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://audit-log/internal/audit-async");
    expect(calls[0]!.headers["x-dub-internal"]).toBe("1");
    expect(calls[0]!.body).toEqual(envelope); // forwarded verbatim
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("done");
  });

  it("keeps the audit row pending on a non-2xx (retry, never lost)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, envelope);
    const { svc } = recordingAudit(500);

    const result = await runOutboxDrain(envWith(d1 as D1Database, svc));

    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1);
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("pending");
  });

  it("defers audit when no SVC_AUDIT binding is present (row retained pending)", async () => {
    const { d1, raw } = makeD1();
    await enqueue(d1 as D1Database, AUDIT_TOPIC, envelope);

    const result = await runOutboxDrain(envWith(d1 as D1Database, undefined));

    expect(result.delivered).toBe(0);
    expect(statusOf(raw, AUDIT_TOPIC)).toBe("pending");
  });
});
