// github-sync is Queue-free on the Workers FREE plan: the producers INSERT into the
// @dub/freeq D1 outbox and a Cron drain forwards rows to their real consumers, while the
// retired Queue consumers are reached over the /internal/*-async HTTP landing routes.
// These tests prove (1) buildPublisherEnv / buildAuditQueue prefer a real Queue when
// present but fall back to the outbox shim when absent, (2) the shim writes durable rows on
// the right topics, (3) the drain delivers audit rows to audit-log and defers domain events
// without ever losing a row, and (4) the landing routes run the SAME sync + idempotency as
// the Queue consumers, guarded by x-dub-internal.
import { describe, it, expect } from "vitest";
import type { AuthClient } from "@dub/auth-client";
import type { Fetcher, Queue, R2Bucket } from "@cloudflare/workers-types";
import { createEvent, type DubEventContext, type DubEventEnvelope, type WebhookEventEnvelopeV1 } from "@dub/events";
import type { task } from "@dub/types";
import { QueuePublisher, buildPublisherEnv, buildAuditQueue } from "../src/events/publisher";
import { makeOutboxDeliver, runOutboxDrain } from "../src/drain";
import { AUDIT_TOPIC, TOPIC_NOTIFICATION } from "../src/outbox";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { makeHarness, issue, fixedNow, type Harness } from "./helpers";
import { makeOutboxD1 } from "./outbox-d1";

const CTX: DubEventContext = { requestId: "req_1", actorId: "user_1" };

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

describe("buildPublisherEnv / buildAuditQueue (binding-presence fallback)", () => {
  it("falls back to the freeq outbox shim for github.* + audit when no Queue bindings are present", async () => {
    const { d1, raw } = makeOutboxD1();
    const env = { DB: d1 } as unknown as Env;
    const publisher = new QueuePublisher(buildPublisherEnv(env), buildAuditQueue(env));

    // github.sync_failed subscribes "notification" -> EVT_NOTIFICATION -> evt.notification.
    await publisher.syncFailed(CTX, "cron", "boom");
    await publisher.audit({
      action: "github.repo.registered",
      actorId: "user_1",
      orgId: "org_devhub",
      result: "success",
      resourceType: "github_repo",
      resourceId: "ghr_1",
      details: { owner: "acme", token: "super-secret" },
      requestId: "req_1",
      occurredAt: fixedNow(),
    });

    const stored = rows(raw);
    expect(stored.map((r) => r.topic).sort()).toEqual([AUDIT_TOPIC, TOPIC_NOTIFICATION]);
    for (const r of stored) expect(r.status).toBe("pending");
    // audit secrets are redacted before durable persistence.
    const auditRow = stored.find((r) => r.topic === AUDIT_TOPIC)!;
    expect(JSON.parse(auditRow.payload).payload.details).toEqual({ owner: "acme", token: "[REDACTED]" });
  });

  it("prefers a real Queue binding over the outbox when present", async () => {
    const { d1, raw } = makeOutboxD1();
    const sent: DubEventEnvelope[] = [];
    const fakeQueue = {
      async send(b: DubEventEnvelope) {
        sent.push(b);
      },
      async sendBatch() {},
    } as unknown as Queue<DubEventEnvelope>;
    const env = { DB: d1, EVT_NOTIFICATION: fakeQueue } as unknown as Env;
    const publisher = new QueuePublisher(buildPublisherEnv(env), buildAuditQueue(env));

    await publisher.syncFailed(CTX, "cron", "boom");
    expect(sent).toHaveLength(1); // real queue used
    expect(rows(raw)).toHaveLength(0); // outbox untouched
  });
});

describe("outbox drain", () => {
  it("delivers audit.record to audit-log /internal/audit-async and marks the row done", async () => {
    const { d1, raw } = makeOutboxD1();
    const { svc, bodies } = fakeAuditSvc(202);
    const publisher = new QueuePublisher(buildPublisherEnv({ DB: d1 } as unknown as Env), buildAuditQueue({ DB: d1 } as unknown as Env));
    await publisher.audit({
      action: "github.repo.registered", actorId: "user_1", orgId: "org_devhub", result: "success",
      resourceType: "github_repo", resourceId: "ghr_1", details: null, requestId: "req_1", occurredAt: fixedNow(),
    });

    const res = await runOutboxDrain({ DB: d1, SVC_AUDIT: svc } as unknown as Env);
    expect(res).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(bodies).toHaveLength(1);
    expect(rows(raw)[0]!.status).toBe("done");
  });

  it("retries (keeps pending) when audit-log returns a non-2xx", async () => {
    const { d1, raw } = makeOutboxD1();
    const { svc } = fakeAuditSvc(500);
    const publisher = new QueuePublisher(buildPublisherEnv({ DB: d1 } as unknown as Env), buildAuditQueue({ DB: d1 } as unknown as Env));
    await publisher.audit({
      action: "github.repo.registered", actorId: "user_1", orgId: "org_devhub", result: "success",
      resourceType: "github_repo", resourceId: "ghr_1", details: null, requestId: "req_1", occurredAt: fixedNow(),
    });

    const res = await runOutboxDrain({ DB: d1, SVC_AUDIT: svc } as unknown as Env);
    expect(res).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    expect(rows(raw)[0]!.status).toBe("pending"); // never lost
  });

  it("defers evt.notification (no free-tier consumer route yet) — row stays pending", async () => {
    const { d1, raw } = makeOutboxD1();
    const publisher = new QueuePublisher(buildPublisherEnv({ DB: d1 } as unknown as Env), buildAuditQueue({ DB: d1 } as unknown as Env));
    await publisher.syncFailed(CTX, "cron", "boom");

    const deliver = makeOutboxDeliver({ DB: d1 } as unknown as Env);
    await expect(deliver({ id: "x", topic: TOPIC_NOTIFICATION, payload: {}, attempts: 1 })).rejects.toThrow();

    const res = await runOutboxDrain({ DB: d1 } as unknown as Env);
    expect(res).toMatchObject({ delivered: 0, retried: 1 });
    expect(rows(raw)[0]!.status).toBe("pending"); // durable, never dropped
  });
});

// ---- free-tier consumer landing routes ----
function fakeAuth(): AuthClient {
  return {
    requireAuth: () => async (c: any, next: any) => {
      c.set("authn", { userId: c.req.header("x-dub-user-id") ?? "u", source: "trusted_header", session: null });
      await next();
    },
    requirePermission: () => async (_c: any, next: any) => next(),
    verify: async () => ({}),
    checkPermissions: async () => ({ decisions: [] }),
    hasPermission: async () => true,
    invalidateAuthzCache: () => {},
  } as unknown as AuthClient;
}

function landingApp(h: Harness) {
  const webhookRaw = { get: async () => null } as unknown as R2Bucket;
  return createApp({
    auth: fakeAuth(),
    service: h.service,
    publisher: h.publisher,
    now: fixedNow,
    queue: { engine: h.engine, processed: h.stores.processed, webhookRaw },
  });
}

const INTERNAL = { "content-type": "application/json", "x-dub-internal": "1" };

function webhookEnvelope(id: string, iss: ReturnType<typeof issue>): WebhookEventEnvelopeV1 {
  return {
    type: "webhook.received", version: 1, id, source: "github", externalId: `gh_${id}`,
    eventKind: "issues", receivedAt: fixedNow(), requestId: "req_wh", headers: {}, r2Key: null,
    payload: {
      action: "opened", sender: { login: "human" },
      repository: { name: iss.repo, owner: { login: iss.owner } },
      issue: { number: iss.number, node_id: iss.nodeId, title: iss.title, body: iss.body, state: iss.state, labels: [], assignees: [], updated_at: iss.updatedAt },
    },
  } as unknown as WebhookEventEnvelopeV1;
}

async function seedRepo(h: Harness): Promise<void> {
  await h.stores.repos.create({
    id: "ghr_main", owner: "acme", repo: "web", eventId: "evt_1", defaultActionId: null,
    origin: "github", direction: "bidirectional", enabled: true, installationId: null,
    projectNumber: null, labelFilter: [], createdBy: "user_1", createdAt: fixedNow(), updatedAt: fixedNow(),
  });
}

describe("POST /internal/webhooks-async (free-tier wh-github landing route)", () => {
  it("404s without the x-dub-internal marker (never public)", async () => {
    const res = await landingApp(makeHarness()).fetch(
      new Request("https://svc/internal/webhooks-async", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookEnvelope("wh_1", issue({ owner: "acme", repo: "web", number: 5 }))),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("applies the webhook (creates a task) and is idempotent on envelope.id", async () => {
    const h = makeHarness();
    await seedRepo(h);
    const app = landingApp(h);
    const env = webhookEnvelope("wh_1", issue({ owner: "acme", repo: "web", number: 5 }));
    const post = () => app.fetch(new Request("https://svc/internal/webhooks-async", { method: "POST", headers: INTERNAL, body: JSON.stringify(env) }));

    const r1 = await post();
    expect(r1.status).toBe(202);
    const r2 = await post(); // redelivery
    expect(r2.status).toBe(202);
    expect(h.tasks.calls.filter((c) => c.op === "createTask")).toHaveLength(1); // dedup by envelope.id
  });

  it("400s on a malformed envelope", async () => {
    const res = await landingApp(makeHarness()).fetch(
      new Request("https://svc/internal/webhooks-async", { method: "POST", headers: INTERNAL, body: JSON.stringify({ nope: true }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /internal/events-async (free-tier evt-github-sync landing route)", () => {
  async function seedLinkedTask(h: Harness): Promise<void> {
    await h.stores.repos.create({
      id: "ghr_main", owner: "acme", repo: "web", eventId: "evt_1", defaultActionId: null,
      origin: "internal", direction: "bidirectional", enabled: true, installationId: null,
      projectNumber: null, labelFilter: [], createdBy: "user_1", createdAt: fixedNow(), updatedAt: fixedNow(),
    });
    const t: task.Task = {
      id: "task_q", eventId: "evt_1", title: "NewTitle", description: "B", status: "todo",
      priority: "medium", assigneeId: null, dueAt: null, origin: "internal", archivedAt: null,
      createdAt: fixedNow(), updatedAt: fixedNow(), version: 2,
    };
    h.tasks.seed(t);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 5, title: "OldIssue", updatedAt: "2026-08-09T00:00:00Z" }));
    await h.stores.links.create({
      id: "ghl_q", taskId: "task_q", repoId: "ghr_main", owner: "acme", repo: "web", issueNumber: 5,
      issueNodeId: "node_5", projectItemId: null, syncState: "in_sync", lastSyncedAt: fixedNow(),
      lastGithubUpdatedAt: "2026-08-09T00:00:00Z", lastTaskVersion: 1, lastError: null,
      createdAt: fixedNow(), updatedAt: fixedNow(),
    });
  }

  it("runs the sync engine + envelope.id idempotency (writes to GitHub once), returns 202", async () => {
    const h = makeHarness();
    await seedLinkedTask(h);
    const app = landingApp(h);
    const ev = createEvent("task.updated", { taskId: "task_q", eventId: "evt_1", changed: ["title"] }, CTX);
    const post = () => app.fetch(new Request("https://svc/internal/events-async", { method: "POST", headers: INTERNAL, body: JSON.stringify(ev) }));

    const r1 = await post();
    expect(r1.status).toBe(202);
    await post(); // redelivery of same envelope.id
    expect(h.github.countOp("updateIssue")).toBe(1);
  });

  it("404s without the x-dub-internal marker", async () => {
    const ev = createEvent("task.updated", { taskId: "task_q", eventId: "evt_1", changed: ["title"] }, CTX);
    const res = await landingApp(makeHarness()).fetch(
      new Request("https://svc/internal/events-async", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) }),
    );
    expect(res.status).toBe(404);
  });

  it("400s on a malformed envelope", async () => {
    const res = await landingApp(makeHarness()).fetch(
      new Request("https://svc/internal/events-async", { method: "POST", headers: INTERNAL, body: JSON.stringify({ nope: true }) }),
    );
    expect(res.status).toBe(400);
  });
});
