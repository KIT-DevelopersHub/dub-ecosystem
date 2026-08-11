// freeq-drain routing + aggregated-drain behaviour. Exercises the real @dub/freeq drain
// against an authentic in-memory SQLite outbox (test/d1.ts) with stub service bindings.
// The headline assertion is the mis-ack regression: a foreign / unknown topic is DEFERRED
// (deliver throws) and its row is NEVER marked `done`.
import { describe, it, expect } from "vitest";
import { drain } from "@dub/freeq";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { Env } from "../src/env";
import { makeDeliver, routeFor } from "../src/routing";
import { drainAll } from "../src/drain-all";
import { makeD1, fakeSvc, seed, readRow } from "./d1";

const OPTS = { batchSize: 25, maxAttempts: Number.MAX_SAFE_INTEGER } as const;

describe("routeFor (single source of truth; default = defer)", () => {
  it("delivers audit.record and the live evt.* topics", () => {
    expect(routeFor("audit.record")).toMatchObject({ kind: "deliver", binding: "SVC_AUDIT_LOG" });
    expect(routeFor("evt.task")).toMatchObject({ kind: "deliver", binding: "SVC_TASK" });
    expect(routeFor("evt.gantt")).toMatchObject({ kind: "deliver", binding: "SVC_GANTT" });
    expect(routeFor("evt.file-meta")).toMatchObject({ kind: "deliver", binding: "SVC_FILE_META" });
    expect(routeFor("evt.github-sync")).toMatchObject({ kind: "deliver", binding: "SVC_GITHUB_SYNC" });
    expect(routeFor("evt.mobile-bff")).toMatchObject({ kind: "deliver", binding: "SVC_MOBILE_BFF" });
  });
  it("defers topics with no live route and ANY unknown topic (never ack)", () => {
    expect(routeFor("evt.notification").kind).toBe("defer");
    expect(routeFor("evt.mail-automation").kind).toBe("defer");
    expect(routeFor("deploy.job").kind).toBe("defer");
    expect(routeFor("foo.bar").kind).toBe("defer"); // default
    expect(routeFor("").kind).toBe("defer");
  });
});

describe("deliver (audit.record + live evt.*)", () => {
  it("POSTs audit.record verbatim to SVC_AUDIT_LOG /internal/audit-async with x-dub-internal; row -> done", async () => {
    const { d1, raw } = makeD1();
    const audit = fakeSvc(200);
    const env = { SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    const payload = { type: "audit.record/v1", id: "aud_1", payload: { action: "x" } };
    seed(raw, "r1", "audit.record", payload);

    const res = await drain(d1, makeDeliver(env), OPTS);

    expect(res).toMatchObject({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]!.url).toBe("https://audit-log/internal/audit-async");
    expect(audit.calls[0]!.method).toBe("POST");
    expect(audit.calls[0]!.headers[HDR_INTERNAL]).toBe(INTERNAL_HEADER_VALUE);
    expect(audit.calls[0]!.body).toEqual(payload); // forwarded verbatim
    expect(readRow(raw, "r1")).toMatchObject({ status: "done", attempts: 1 });
  });

  it("POSTs evt.task to SVC_TASK /internal/events-async; row -> done", async () => {
    const { d1, raw } = makeD1();
    const task = fakeSvc(200);
    const env = { SVC_TASK: task.svc } as unknown as Env;
    const envelope = { id: "evt_1", name: "task.created", payload: {} };
    seed(raw, "r2", "evt.task", envelope);

    const res = await drain(d1, makeDeliver(env), OPTS);

    expect(res.delivered).toBe(1);
    expect(task.calls[0]!.url).toBe("https://task-service/internal/events-async");
    expect(task.calls[0]!.headers[HDR_INTERNAL]).toBe(INTERNAL_HEADER_VALUE);
    expect(task.calls[0]!.body).toEqual(envelope);
    expect(readRow(raw, "r2")).toMatchObject({ status: "done" });
  });

  it("POSTs evt.github-sync to SVC_GITHUB_SYNC /internal/events-async; row -> done", async () => {
    const { d1, raw } = makeD1();
    const gh = fakeSvc(200);
    const env = { SVC_GITHUB_SYNC: gh.svc } as unknown as Env;
    seed(raw, "r3", "evt.github-sync", { id: "evt_2", name: "task.updated" });

    const res = await drain(d1, makeDeliver(env), OPTS);

    expect(res.delivered).toBe(1);
    expect(gh.calls[0]!.url).toBe("https://github-sync/internal/events-async");
    expect(readRow(raw, "r3")).toMatchObject({ status: "done" });
  });
});

describe("MIS-ACK REGRESSION: foreign / unknown topics are DEFERRED, never acked", () => {
  it("evt.notification, deploy.job and an unknown foo.bar stay pending (attempts++), never done", async () => {
    const { d1, raw } = makeD1();
    // Only an audit binding is present — the drain must NOT ack the foreign rows just
    // because it cannot deliver them (that was the data-loss bug).
    const audit = fakeSvc(200);
    const env = { SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    seed(raw, "n1", "evt.notification", { id: "e1" });
    seed(raw, "d1row", "deploy.job", { tag: "deploy-job/v1" });
    seed(raw, "u1", "foo.bar", { anything: true });

    const res = await drain(d1, makeDeliver(env), OPTS);

    expect(res).toMatchObject({ claimed: 3, delivered: 0, retried: 3, failed: 0 });
    for (const id of ["n1", "d1row", "u1"]) {
      const row = readRow(raw, id)!;
      expect(row.status).toBe("pending"); // NOT done — the mis-ack fix
      expect(row.attempts).toBe(1); // attempt was recorded (retry with backoff)
      expect(row.last_error).toContain("no live consumer route");
    }
    expect(audit.calls).toHaveLength(0); // nothing was delivered anywhere
  });

  it("a live topic whose binding is absent at runtime DEFERS (does not crash, not acked)", async () => {
    const { d1, raw } = makeD1();
    const env = {} as unknown as Env; // no SVC_TASK bound
    seed(raw, "r1", "evt.task", { id: "e" });

    const res = await drain(d1, makeDeliver(env), OPTS);

    expect(res.retried).toBe(1);
    expect(readRow(raw, "r1")).toMatchObject({ status: "pending", attempts: 1 });
  });
});

describe("retry on HTTP 500 (never failed; maxAttempts huge)", () => {
  it("a 500 keeps the row pending, increments attempts, sets last_error", async () => {
    const { d1, raw } = makeD1();
    const audit = fakeSvc(500);
    const env = { SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    seed(raw, "r1", "audit.record", { id: "a" });

    const res = await drain(d1, makeDeliver(env), OPTS);

    expect(res).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    const row = readRow(raw, "r1")!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("returned 500");
  });

  it("recovers on a later drain once the consumer returns 2xx (idempotent redelivery is safe)", async () => {
    const { d1, raw } = makeD1();
    // 500 on the first call, 200 afterwards.
    const audit = fakeSvc((n) => (n === 1 ? 500 : 200));
    const env = { SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    seed(raw, "r1", "audit.record", { id: "a" });

    // First pass fails -> pending, next_attempt_at pushed into the future.
    await drain(d1, makeDeliver(env), { ...OPTS, now: () => Date.parse("2000-01-01T00:00:00.000Z") });
    expect(readRow(raw, "r1")).toMatchObject({ status: "pending", attempts: 1 });

    // A much later pass re-claims and succeeds; single terminal state, no crash.
    await drain(d1, makeDeliver(env), { ...OPTS, now: () => Date.parse("2001-01-01T00:00:00.000Z") });
    const row = readRow(raw, "r1")!;
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(2);
    expect(audit.calls).toHaveLength(2); // redelivered; consumer dedups on envelope id
  });
});

describe("drainAll (multi-DB, best-effort)", () => {
  it("drains rows from more than one bound outbox D1 in a single pass", async () => {
    const core = makeD1();
    const authDb = makeD1();
    const audit = fakeSvc(200);
    const task = fakeSvc(200);
    seed(core.raw, "c1", "audit.record", { id: "a" });
    seed(core.raw, "c2", "evt.task", { id: "t" });
    seed(authDb.raw, "a1", "audit.record", { id: "b" });

    const env = {
      DB_CORE: core.d1,
      DB_AUTH: authDb.d1,
      SVC_AUDIT_LOG: audit.svc,
      SVC_TASK: task.svc,
    } as unknown as Env;

    const out = await drainAll(env);

    expect(out.DB_CORE).toMatchObject({ ok: true, claimed: 2, delivered: 2 });
    expect(out.DB_AUTH).toMatchObject({ ok: true, claimed: 1, delivered: 1 });
    expect(out.DB_DRIVE).toBeUndefined(); // unbound -> skipped
    expect(readRow(core.raw, "c1")).toMatchObject({ status: "done" });
    expect(readRow(core.raw, "c2")).toMatchObject({ status: "done" });
    expect(readRow(authDb.raw, "a1")).toMatchObject({ status: "done" });
    expect(audit.calls).toHaveLength(2);
    expect(task.calls).toHaveLength(1);
  });

  it("one DB's failure is recorded but does not abort the others", async () => {
    const core = makeD1();
    const audit = fakeSvc(200);
    seed(core.raw, "c1", "audit.record", { id: "a" });

    // A broken D1 whose claim query throws.
    const broken = {
      prepare() {
        throw new Error("boom: auth-outbox unavailable");
      },
    } as unknown as import("@cloudflare/workers-types").D1Database;

    const env = { DB_CORE: core.d1, DB_AUTH: broken, SVC_AUDIT_LOG: audit.svc } as unknown as Env;

    const out = await drainAll(env);

    expect(out.DB_AUTH).toMatchObject({ ok: false });
    expect(out.DB_CORE).toMatchObject({ ok: true, delivered: 1 }); // still drained
    expect(readRow(core.raw, "c1")).toMatchObject({ status: "done" });
  });
});
