import { describe, it, expect, vi } from "vitest";
import type { Fetcher, MessageBatch } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import { HEADERS } from "@dub/observability";
import type { auditLog } from "@dub/types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import { makeD1 } from "./d1";
import { createApp } from "../src/app";
import { consumeAuditQueue } from "../src/queue";
import { archiveOldRecords, retentionCutoffIso } from "../src/archive";
import { insertRecord, getById, queryLogs, deleteBefore } from "../src/repo";
import type { Env } from "../src/env";

// ---- fixtures -------------------------------------------------------------

function input(over: Partial<auditLog.AuditRecordInput> = {}): auditLog.AuditRecordInput {
  return {
    action: "task.deleted",
    actorId: "user_1",
    orgId: "org_devhub",
    result: "success",
    resourceType: "task",
    resourceId: "task_1",
    details: { foo: "bar" },
    requestId: "req_1",
    occurredAt: "2026-08-09T00:00:00.000Z",
    ...over,
  };
}

function identity(allowed: boolean): Fetcher {
  return {
    fetch: async () =>
      new Response(JSON.stringify({ decisions: [{ allowed, evaluatedAt: new Date().toISOString(), ttlSeconds: 60 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Fetcher;
}

function stubBucket() {
  const put = vi.fn(async () => ({}));
  // NonNullable: AUDIT_ARCHIVE is optional on Env (absent on the free plan), but the archive
  // job is only ever called with a real bucket, so the stub is the non-undefined R2Bucket.
  return { bucket: { put } as unknown as NonNullable<Env["AUDIT_ARCHIVE"]>, put };
}

function makeEnv(d1: Env["DB"], opts: { allow?: boolean; bucket?: Env["AUDIT_ARCHIVE"] } = {}): Env {
  return { DB: d1, SVC_IDENTITY: identity(opts.allow ?? true), AUDIT_ARCHIVE: opts.bucket ?? stubBucket().bucket };
}

function envelope(id: string, over: Partial<auditLog.AuditRecordInput> = {}): AuditRecordEnvelopeV1 {
  return { type: "audit.record", version: 1, id, payload: input(over) };
}

function batchOf(bodies: unknown[]) {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  return { batch: { messages } as unknown as MessageBatch<AuditRecordEnvelopeV1>, messages };
}

const auditDb = (d1: Env["DB"]) => createDbClient(d1, { namespace: "audit" });

// ---- 1,2,10  Queue write path --------------------------------------------

describe("audit-log queue consumer", () => {
  it("#1 inserts a valid envelope and it is retrievable", async () => {
    const { d1 } = makeD1();
    const { batch, messages } = batchOf([envelope("ULID0001")]);
    await consumeAuditQueue(batch, makeEnv(d1));
    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(messages[0]!.retry).not.toHaveBeenCalled();
    const rec = await getById(auditDb(d1), "ULID0001");
    expect(rec?.id).toBe("ULID0001");
    expect(rec?.action).toBe("task.deleted");
    expect(rec?.details).toEqual({ foo: "bar" });
    expect(rec?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("#2 is idempotent on re-delivery (INSERT OR IGNORE)", async () => {
    const { d1 } = makeD1();
    const { batch } = batchOf([envelope("DUP1"), envelope("DUP1", { result: "failure" })]);
    await consumeAuditQueue(batch, makeEnv(d1));
    const page = await queryLogs(auditDb(d1), {});
    expect(page.items.length).toBe(1);
    expect(page.items[0]!.result).toBe("success"); // first write wins
  });

  it("#10 retries poison messages without crashing the batch", async () => {
    const { d1 } = makeD1();
    const { batch, messages } = batchOf([{ not: "an envelope" }, envelope("GOOD1")]);
    await expect(consumeAuditQueue(batch, makeEnv(d1))).resolves.toBeUndefined();
    expect(messages[0]!.retry).toHaveBeenCalled();
    expect(messages[0]!.ack).not.toHaveBeenCalled();
    expect(messages[1]!.ack).toHaveBeenCalled();
    expect((await getById(auditDb(d1), "GOOD1"))?.id).toBe("GOOD1");
  });
});

// ---- 3,4,9  Sync fail-close write route ----------------------------------

describe("POST /internal/log (sync fail-close)", () => {
  const post = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
    createApp().fetch(
      new Request("https://svc/internal/log", {
        method: "POST",
        headers: { "content-type": "application/json", [HEADERS.internal]: "1", ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );

  it("#3 accepts a SYNC_AUDIT_ACTIONS action and returns 201 + {id}", async () => {
    const { d1 } = makeD1();
    const res = await post(makeEnv(d1), input({ action: "identity.role.assigned" }), { [HEADERS.idempotencyKey]: "IDEM1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as auditLog.AuditLogWriteResponse;
    expect(body.id).toBe("IDEM1");
    expect((await getById(auditDb(d1), "IDEM1"))?.action).toBe("identity.role.assigned");
  });

  it("#4 rejects an action outside the sync catalog (400) and does not insert", async () => {
    const { d1 } = makeD1();
    const res = await post(makeEnv(d1), input({ action: "mail.sent" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(0);
  });

  it("#9 rejects >8KB details and bad enums (400), no insert", async () => {
    const { d1 } = makeD1();
    const big = await post(makeEnv(d1), input({ action: "identity.role.assigned", details: { blob: "x".repeat(9000) } }));
    expect(big.status).toBe(400);
    const bad = await post(makeEnv(d1), input({ action: "identity.role.assigned", result: "weird" as auditLog.AuditResult }));
    expect(bad.status).toBe(400);
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(0);
  });

  it("returns 404 when the x-dub-internal marker is absent (mirrors gateway)", async () => {
    const { d1 } = makeD1();
    const res = await createApp().fetch(
      new Request("https://svc/internal/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input({ action: "identity.role.assigned" })),
      }),
      makeEnv(d1),
    );
    expect(res.status).toBe(404);
  });
});

// ---- async ingest write route (free-tier outbox drain landing) -----------
// POST /internal/audit-async receives the AuditRecordEnvelopeV1 that auth-service's
// @dub/freeq Cron drain forwards over its SVC_AUDIT binding (PR #106). Contract mirror:
//   path    = /internal/audit-async
//   headers = x-dub-internal:"1" (presence marker) + content-type: application/json
//   body    = { type:"audit.record", version:1, id, payload: AuditRecordInput }
// Open catalog (no SYNC_AUDIT_ACTIONS gate) so auth.session.* lands here, not /internal/log.

describe("POST /internal/audit-async (async ingest, open catalog)", () => {
  // Exact byte shape the drain emits (services/auth-service/src/drain.ts makeAuditDeliver).
  const post = (env: Env, body: unknown, internal = true) =>
    createApp().fetch(
      new Request("https://svc/internal/audit-async", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(internal ? { [HEADERS.internal]: "1" } : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
    );

  it("accepts auth.session.login (a non-sync action) and persists it (202 + {id})", async () => {
    const { d1 } = makeD1();
    const res = await post(makeEnv(d1), envelope("SESS_LOGIN_1", { action: "auth.session.login", actorId: "user_42", resourceType: null, resourceId: null, details: null }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as auditLog.AuditLogWriteResponse;
    expect(body.id).toBe("SESS_LOGIN_1");
    const rec = await getById(auditDb(d1), "SESS_LOGIN_1");
    expect(rec?.action).toBe("auth.session.login");
    expect(rec?.actorId).toBe("user_42");
    expect(rec?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("also accepts auth.session.logout (proves the sync catalog gate does NOT apply)", async () => {
    const { d1 } = makeD1();
    const res = await post(makeEnv(d1), envelope("SESS_LOGOUT_1", { action: "auth.session.logout" }));
    expect(res.status).toBe(202);
    expect((await getById(auditDb(d1), "SESS_LOGOUT_1"))?.action).toBe("auth.session.logout");
  });

  it("is idempotent on at-least-once re-delivery (same envelope id => one row, first wins)", async () => {
    const { d1 } = makeD1();
    await post(makeEnv(d1), envelope("REDELIVER_1", { action: "auth.session.login", result: "success" }));
    await post(makeEnv(d1), envelope("REDELIVER_1", { action: "auth.session.login", result: "failure" }));
    const page = await queryLogs(auditDb(d1), {});
    expect(page.items.length).toBe(1);
    expect(page.items[0]!.result).toBe("success");
  });

  it("rejects a malformed envelope (400) and inserts nothing => drain retries, not loses", async () => {
    const { d1 } = makeD1();
    // Missing `type` — parseAuditEnvelope must reject before touching the payload.
    const res = await post(makeEnv(d1), { version: 1, id: "NOPE", payload: input({ action: "auth.session.login" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(0);
  });

  it("rejects an envelope whose payload fails validation (400), no insert", async () => {
    const { d1 } = makeD1();
    const res = await post(makeEnv(d1), envelope("BAD_PAYLOAD_1", { orgId: "" as auditLog.AuditRecordInput["orgId"] }));
    expect(res.status).toBe(400);
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(0);
  });

  it("returns 404 when the x-dub-internal marker is absent (never publicly reachable)", async () => {
    const { d1 } = makeD1();
    const res = await post(makeEnv(d1), envelope("PUBLIC_1", { action: "auth.session.login" }), /* internal */ false);
    expect(res.status).toBe(404);
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(0);
  });

  it("append-only holds for async-ingested rows: UPDATE and in-window DELETE are rejected", async () => {
    const { d1, raw } = makeD1();
    await post(makeEnv(d1), envelope("APPEND_1", { action: "auth.session.login", occurredAt: new Date().toISOString() }));
    expect(() => raw.exec("UPDATE audit_logs SET action='hacked' WHERE id='APPEND_1'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM audit_logs WHERE id='APPEND_1'")).toThrow(/append-only/);
    expect((await getById(auditDb(d1), "APPEND_1"))?.action).toBe("auth.session.login");
  });
});

// ---- async ingest: LEGACY FLAT backward-compat (the pre-fix auth-outbox backlog) --------
// Before the producer wrapped its records, the auth-outbox enqueued a bare AuditRecordInput,
// so the shared freeq-drain forwarded a FLAT body here — which the strict envelope validator
// rejected with 400 (the ~42 stuck rows). /internal/audit-async now ALSO accepts the flat
// shape, normalizing it and deriving a deterministic idempotency id so the backlog drains
// without loss or duplication. New producers keep emitting the wrapped envelope.

describe("POST /internal/audit-async (legacy FLAT record backward-compat)", () => {
  const postFlat = (env: Env, flat: unknown, internal = true) =>
    createApp().fetch(
      new Request("https://svc/internal/audit-async", {
        method: "POST",
        headers: { "content-type": "application/json", ...(internal ? { [HEADERS.internal]: "1" } : {}) },
        body: JSON.stringify(flat),
      }),
      env,
    );

  it("accepts a bare AuditRecordInput (no envelope) and persists it (202 + derived id)", async () => {
    const { d1 } = makeD1();
    const flat = input({ action: "auth.session.login", actorId: "user_9", requestId: "req_legacy_1" });
    const res = await postFlat(makeEnv(d1), flat);
    expect(res.status).toBe(202);
    const body = (await res.json()) as auditLog.AuditLogWriteResponse;
    expect(body.id).toMatch(/^aud_legacy_[0-9a-f]{64}$/); // deterministic content hash
    const rec = await getById(auditDb(d1), body.id);
    expect(rec?.action).toBe("auth.session.login");
    expect(rec?.actorId).toBe("user_9");
    expect(rec?.requestId).toBe("req_legacy_1");
  });

  it("derives a STABLE id => at-least-once redelivery of the same flat row dedupes (one row)", async () => {
    const { d1 } = makeD1();
    const flat = input({ action: "auth.session.logout", actorId: "user_9", requestId: "req_legacy_2" });
    const r1 = await postFlat(makeEnv(d1), flat);
    const r2 = await postFlat(makeEnv(d1), flat);
    const id1 = ((await r1.json()) as auditLog.AuditLogWriteResponse).id;
    const id2 = ((await r2.json()) as auditLog.AuditLogWriteResponse).id;
    expect(id1).toBe(id2); // deterministic => same key
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(1); // INSERT OR IGNORE => no dup
  });

  it("distinct flat events get distinct ids (no false-merge)", async () => {
    const { d1 } = makeD1();
    const a = await postFlat(makeEnv(d1), input({ requestId: "req_a" }));
    const b = await postFlat(makeEnv(d1), input({ requestId: "req_b" }));
    const idA = ((await a.json()) as auditLog.AuditLogWriteResponse).id;
    const idB = ((await b.json()) as auditLog.AuditLogWriteResponse).id;
    expect(idA).not.toBe(idB);
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(2);
  });

  it("still rejects a flat body that fails record validation (400, no insert)", async () => {
    const { d1 } = makeD1();
    const res = await postFlat(makeEnv(d1), input({ action: "NOT valid action" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect((await queryLogs(auditDb(d1), {})).items.length).toBe(0);
  });

  it("the wrapped envelope path is unaffected (still keyed by envelope id)", async () => {
    const { d1 } = makeD1();
    const res = await postFlat(makeEnv(d1), envelope("WRAPPED_1", { action: "auth.session.login" }));
    expect(res.status).toBe(202);
    expect(((await res.json()) as auditLog.AuditLogWriteResponse).id).toBe("WRAPPED_1");
  });
});

// ---- 7,8,13  Read query route --------------------------------------------

describe("GET /audit/logs (read, audit:read gated)", () => {
  const get = (env: Env, qs: string, headers: Record<string, string> = {}) =>
    createApp().fetch(new Request(`https://svc/audit/logs${qs}`, { headers }), env);

  it("#8 401 when unauthenticated, 403 when audit:read denied", async () => {
    const { d1 } = makeD1();
    const unauth = await get(makeEnv(d1), "");
    expect(unauth.status).toBe(401);
    const denied = await get(makeEnv(d1, { allow: false }), "", { [HEADERS.userId]: "user_x" });
    expect(denied.status).toBe(403);
  });

  it("#7 paginates newest-first with a working cursor", async () => {
    const { d1 } = makeD1();
    const db = auditDb(d1);
    for (const n of ["A1", "A2", "A3", "A4", "A5"]) {
      await insertRecord(db, n, input({ occurredAt: `2026-08-0${n[1]}T00:00:00.000Z` }));
    }
    const h = { [HEADERS.userId]: "admin" };
    const p1 = (await (await get(makeEnv(d1), "?limit=2", h)).json()) as auditLog.AuditLogPage;
    expect(p1.items.map((r) => r.id)).toEqual(["A5", "A4"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await (await get(makeEnv(d1), `?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`, h)).json()) as auditLog.AuditLogPage;
    expect(p2.items.map((r) => r.id)).toEqual(["A3", "A2"]);
    const p3 = (await (await get(makeEnv(d1), `?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}`, h)).json()) as auditLog.AuditLogPage;
    expect(p3.items.map((r) => r.id)).toEqual(["A1"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("#7 filters by actor, action-prefix and time window", async () => {
    const { d1 } = makeD1();
    const db = auditDb(d1);
    await insertRecord(db, "B1", input({ action: "infra.deploy.executed", actorId: "u_a", occurredAt: "2026-06-01T00:00:00.000Z" }));
    await insertRecord(db, "B2", input({ action: "infra.dns.changed", actorId: "u_a", occurredAt: "2026-07-01T00:00:00.000Z" }));
    await insertRecord(db, "B3", input({ action: "task.deleted", actorId: "u_b", occurredAt: "2026-08-01T00:00:00.000Z" }));
    const h = { [HEADERS.userId]: "admin" };
    const byPrefix = (await (await get(makeEnv(d1), "?action=infra.", h)).json()) as auditLog.AuditLogPage;
    expect(byPrefix.items.map((r) => r.id).sort()).toEqual(["B1", "B2"]);
    const byActor = (await (await get(makeEnv(d1), "?actorId=u_b", h)).json()) as auditLog.AuditLogPage;
    expect(byActor.items.map((r) => r.id)).toEqual(["B3"]);
    const byWindow = (await (await get(makeEnv(d1), "?since=2026-06-15T00:00:00.000Z&until=2026-07-15T00:00:00.000Z", h)).json()) as auditLog.AuditLogPage;
    expect(byWindow.items.map((r) => r.id)).toEqual(["B2"]);
  });

  it("rejects limit>200 (400)", async () => {
    const { d1 } = makeD1();
    const res = await get(makeEnv(d1), "?limit=500", { [HEADERS.userId]: "admin" });
    expect(res.status).toBe(400);
  });

  it("rejects an un-decodable cursor (400 invalid_cursor)", async () => {
    const { d1 } = makeD1();
    // "!!!" is not valid base64url; decodeCursor must surface a VALIDATION_FAILED
    // with details field "cursor" / reason "invalid_cursor" (contract §5.1).
    const res = await get(makeEnv(d1), "?cursor=%21%21%21", { [HEADERS.userId]: "admin" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { field: string; reason: string }[] } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toContainEqual(expect.objectContaining({ field: "cursor", reason: "invalid_cursor" }));
  });

  it("#13 GET /audit/logs/:id returns the contract shape (404 when absent)", async () => {
    const { d1 } = makeD1();
    await insertRecord(auditDb(d1), "C1", input());
    const ok = await createApp().fetch(new Request("https://svc/audit/logs/C1", { headers: { [HEADERS.userId]: "admin" } }), makeEnv(d1));
    expect(ok.status).toBe(200);
    const rec = (await ok.json()) as auditLog.AuditRecord;
    expect(Object.keys(rec).sort()).toEqual(
      ["action", "actorId", "details", "id", "occurredAt", "orgId", "recordedAt", "requestId", "resourceId", "resourceType", "result"].sort(),
    );
    const miss = await createApp().fetch(new Request("https://svc/audit/logs/NOPE", { headers: { [HEADERS.userId]: "admin" } }), makeEnv(d1));
    expect(miss.status).toBe(404);
  });
});

// ---- 5,6  Append-only triggers (real SQLite) -----------------------------

describe("append-only guarantees (DB triggers)", () => {
  it("#5 forbids UPDATE and in-window DELETE", async () => {
    const { d1, raw } = makeD1();
    await insertRecord(auditDb(d1), "T1", input({ occurredAt: new Date().toISOString() }));
    expect(() => raw.exec("UPDATE audit_logs SET action='hacked' WHERE id='T1'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM audit_logs WHERE id='T1'")).toThrow(/append-only/);
    expect((await getById(auditDb(d1), "T1"))?.action).toBe("task.deleted");
  });

  it("#6 allows DELETE of rows older than the retention window", async () => {
    const { d1, raw } = makeD1();
    await insertRecord(auditDb(d1), "OLD1", input({ occurredAt: "2020-01-01T00:00:00.000Z" }));
    expect(() => raw.exec("DELETE FROM audit_logs WHERE id='OLD1'")).not.toThrow();
    expect(await getById(auditDb(d1), "OLD1")).toBeNull();
  });

  it("#6 deleteBefore() cannot prune in-window rows: the trigger guards the archive path", async () => {
    const { d1 } = makeD1();
    const db = auditDb(d1);
    // A recent (in-window) row and an old (out-of-window) row.
    await insertRecord(db, "RECENT1", input({ occurredAt: new Date().toISOString() }));
    await insertRecord(db, "ANCIENT1", input({ occurredAt: "2020-01-01T00:00:00.000Z" }));
    // A mis-computed cutoff in the future would sweep the recent row too — the
    // audit_logs_no_delete trigger ABORTs the whole statement (all-or-nothing),
    // so the archive delete path can never breach append-only regardless of cutoff.
    // (@dub/db wraps the trigger's ABORT into a generic "D1 query failed"; the
    // load-bearing proof is that BOTH rows survive — the statement rolled back.)
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await expect(deleteBefore(db, future)).rejects.toThrow();
    expect((await getById(db, "RECENT1"))?.id).toBe("RECENT1"); // in-window: protected
    expect((await getById(db, "ANCIENT1"))?.id).toBe("ANCIENT1"); // statement rolled back
  });
});

// ---- 11  Monthly archive job ---------------------------------------------

describe("monthly R2 archive", () => {
  it("#11 moves out-of-window rows to R2 NDJSON, deletes them, keeps recent", async () => {
    const { d1 } = makeD1();
    const db = auditDb(d1);
    const now = new Date("2026-08-09T00:00:00.000Z");
    await insertRecord(db, "OLDA", input({ occurredAt: "2026-03-15T00:00:00.000Z" }));
    await insertRecord(db, "OLDB", input({ occurredAt: "2026-03-20T00:00:00.000Z" }));
    await insertRecord(db, "NEW1", input({ occurredAt: "2026-08-01T00:00:00.000Z" }));

    const { bucket, put } = stubBucket();
    const summary = await archiveOldRecords(db, bucket, now);

    expect(summary.archived).toBe(2);
    expect(summary.months).toEqual(["2026-03"]);
    expect(put).toHaveBeenCalledTimes(1);
    const [key, body] = put.mock.calls[0] as unknown as [string, string];
    expect(key).toBe("audit-archive/2026-03.ndjson");
    const lines = (body as string).trim().split("\n").map((l) => JSON.parse(l) as auditLog.AuditRecord);
    expect(lines.map((r) => r.id).sort()).toEqual(["OLDA", "OLDB"]);
    expect(await getById(db, "OLDA")).toBeNull();
    expect((await getById(db, "NEW1"))?.id).toBe("NEW1");
  });

  it("retentionCutoffIso subtracts the retention window", () => {
    expect(retentionCutoffIso(new Date("2026-08-09T00:00:00.000Z"))).toBe("2026-05-09T00:00:00.000Z");
  });
});

// ---- 12  deploy intent/result linkage ------------------------------------

describe("deploy intent/result two-phase linkage", () => {
  it("#12 links the Queue result record back to the sync intent id", async () => {
    const { d1 } = makeD1();
    const env = makeEnv(d1);

    // intent phase — synchronous, fail-close
    const intentRes = await createApp().fetch(
      new Request("https://svc/internal/log", {
        method: "POST",
        headers: { "content-type": "application/json", [HEADERS.internal]: "1", [HEADERS.idempotencyKey]: "INTENT1" },
        body: JSON.stringify(input({ action: "infra.deploy.executed", result: "intent", resourceType: "deployment", resourceId: "dep_1" })),
      }),
      env,
    );
    const { id: intentId } = (await intentRes.json()) as auditLog.AuditLogWriteResponse;

    // result phase — asynchronous, via Queue
    const { batch } = batchOf([
      envelope("RESULT1", { action: "infra.deploy.executed", result: "success", resourceType: "deployment", resourceId: "dep_1", details: { intent_id: intentId } }),
    ]);
    await consumeAuditQueue(batch, env);

    const intent = await getById(auditDb(d1), intentId);
    const result = await getById(auditDb(d1), "RESULT1");
    expect(intent?.result).toBe("intent");
    expect(result?.result).toBe("success");
    expect((result?.details as { intent_id: string }).intent_id).toBe(intentId);
  });
});
