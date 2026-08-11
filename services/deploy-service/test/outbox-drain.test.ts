// deploy-service is Queue-free on the free tier: the result-stage audit, the deploy.*
// domain-event fan-out and the PRIVATE deploy-jobs lane all INSERT into the @dub/freeq D1
// outbox, and a Cron drain forwards each row to its real consumer. These tests prove the
// producer fallback writes durable rows and the drain (1) forwards audit verbatim to
// audit-log, (2) runs a deploy job in process via the SAME handler, and (3) defers a
// domain event without losing it.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { AUDIT_TOPIC, TOPIC_NOTIFICATION, TOPIC_DEPLOY_JOB, outboxQueue, enqueueDeployJob } from "../src/outbox";
import { runOutboxDrain } from "../src/drain";
import { buildDeps } from "../src/deps";
import type { Env } from "../src/env";
import type { Deps } from "../src/deps";
import type { DeployJobMessage } from "../src/jobs";
import { makeOutboxD1, rows } from "./outbox-d1";
import { createFakeCf, createFakeAudit, createFakeEvents, createFakeIdentityBinding } from "./helpers";
import { createInMemoryDeployRepo } from "../src/memory-repo";
import { createAuthClient } from "@dub/auth-client";

/** A fake audit-log service binding that records forwarded bodies and returns a status. */
function fakeAuditSvc(status = 202): { svc: Fetcher; bodies: unknown[]; urls: string[] } {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const svc = {
    async fetch(url: string, init?: RequestInit) {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body ?? "null")));
      return new Response(null, { status });
    },
  } as unknown as Fetcher;
  return { svc, bodies, urls };
}

function envWith(d1: ReturnType<typeof makeOutboxD1>["d1"], svcAudit: Fetcher): Env {
  return { DB: d1, SVC_AUDIT_LOG: svcAudit } as unknown as Env;
}

const DEPLOY_JOB: DeployJobMessage = {
  tag: "deploy-job/v1",
  kind: "execute",
  deploymentId: "PLACEHOLDER",
  siteId: "site_1",
  cfProjectName: "public-hp",
  branch: "main",
  commitSha: "abc123",
  requestId: "req_drain_1",
  actorId: "usr_admin",
  intentId: "aud_intent_1",
  attempt: 0,
};

describe("free-tier outbox producer fallback (no Queue bindings)", () => {
  it("recordResult with no AUDIT_QUEUE durably INSERTs an audit.record envelope", async () => {
    const { d1, raw } = makeOutboxD1();
    const env = envWith(d1, fakeAuditSvc().svc);
    // buildDeps with only DB + SVC_* set -> audit gateway falls back to the freeq shim.
    const deps: Deps = buildDeps(env, "req_1");
    await deps.audit.recordResult(
      { requestId: "req_1", userId: "usr_admin" },
      {
        action: "infra.deploy.executed",
        actorId: "usr_admin",
        result: "success",
        resourceType: "deployment",
        resourceId: "dep_1",
        intentId: "aud_intent_1",
        details: { siteId: "site_1", status: "live" },
      },
    );
    const stored = rows(raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic).toBe(AUDIT_TOPIC);
    expect(stored[0]!.status).toBe("pending");
    const payload = JSON.parse(stored[0]!.payload);
    expect(payload.type).toBe("audit.record"); // publishAudit envelope shape
    expect(payload.payload.action).toBe("infra.deploy.executed");
    expect(payload.payload.details.intent_id).toBe("aud_intent_1");
  });

  it("enqueueJob with no DEPLOY_JOBS binding durably INSERTs a deploy.job row", async () => {
    const { d1, raw } = makeOutboxD1();
    const env = envWith(d1, fakeAuditSvc().svc);
    const deps: Deps = buildDeps(env, "req_1");
    await deps.enqueueJob({ ...DEPLOY_JOB, deploymentId: "dep_1" });
    const stored = rows(raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic).toBe(TOPIC_DEPLOY_JOB);
    expect(JSON.parse(stored[0]!.payload).kind).toBe("execute");
  });
});

describe("runOutboxDrain", () => {
  it("forwards audit.record verbatim to audit-log /internal/audit-async and marks it done", async () => {
    const { d1, raw } = makeOutboxD1();
    const audit = fakeAuditSvc(202);
    const envelope = { type: "audit.record", version: 1, id: "aud_x", payload: { action: "infra.deploy.executed" } };
    await outboxQueue(d1, AUDIT_TOPIC).send(envelope);

    const result = await runOutboxDrain(envWith(d1, audit.svc));

    expect(result.delivered).toBe(1);
    expect(audit.urls[0]).toContain("/internal/audit-async");
    expect(audit.bodies[0]).toEqual(envelope); // forwarded verbatim
    expect(rows(raw)[0]!.status).toBe("done");
  });

  it("retries (never drops) when audit-log returns a non-2xx", async () => {
    const { d1, raw } = makeOutboxD1();
    const audit = fakeAuditSvc(503);
    await outboxQueue(d1, AUDIT_TOPIC).send({ type: "audit.record", version: 1, id: "aud_y", payload: {} });

    const result = await runOutboxDrain(envWith(d1, audit.svc));

    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1);
    const row = rows(raw)[0]!;
    expect(row.status).toBe("pending"); // durable, retried later
    expect(row.last_error).toContain("503");
  });

  it("defers evt.notification (no free-tier consumer route) keeping the row pending", async () => {
    const { d1, raw } = makeOutboxD1();
    await outboxQueue(d1, TOPIC_NOTIFICATION).send({ type: "deploy.deployment.status_changed", id: "evt_1" });

    const result = await runOutboxDrain(envWith(d1, fakeAuditSvc().svc));

    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1); // deferral -> retry, huge maxAttempts keeps it off 'failed'
    expect(rows(raw)[0]!.status).toBe("pending");
  });

  it("runs a deploy.job in process via the same handler (CF live -> deployment live), row done", async () => {
    const { d1, raw } = makeOutboxD1();

    // In-memory deploy world injected via makeDeps so processJob runs without real D1/CF.
    const repo = createInMemoryDeployRepo();
    const site = await repo.createSite({
      name: "public-hp",
      domain: null,
      cfProjectName: "public-hp",
      zoneId: null,
      defaultBranch: "main",
      createdBy: "usr_admin",
    });
    const dep = await repo.createDeployment({ siteId: site.id, branch: "main", commitSha: "abc123", requestedBy: "usr_admin" });
    const cf = createFakeCf({ pagesResult: { cfDeploymentId: "cfdep_9", status: "live", url: "https://hp.pages.dev" } });
    const audit = createFakeAudit();
    const events = createFakeEvents();
    const { binding } = createFakeIdentityBinding({ usr_admin: ["infra:deploy"] });
    const auth = createAuthClient({ identityBinding: binding, serviceName: "deploy-service" });
    const injected: Deps = {
      repo,
      cf,
      audit,
      events,
      auth,
      async enqueueJob(msg) {
        await enqueueDeployJob(d1, msg); // durable re-enqueue (poll loop) on the free tier
      },
    };

    await enqueueDeployJob(d1, { ...DEPLOY_JOB, deploymentId: dep.id });
    const result = await runOutboxDrain(envWith(d1, fakeAuditSvc().svc), () => injected);

    expect(result.delivered).toBe(1);
    const row = await repo.getDeployment(dep.id);
    expect(row!.status).toBe("live");
    expect(row!.url).toBe("https://hp.pages.dev");
    expect(audit.results[0]!.result).toBe("success");
    expect(events.events.some((e) => e.kind === "deployment" && e.payload.status === "live")).toBe(true);
    expect(rows(raw)[0]!.status).toBe("done");
  });
});
