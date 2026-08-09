import { describe, it, expect, beforeEach } from "vitest";
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { deploy } from "@dub/types";
import { createApp } from "../src/app";
import { handleDeployJobs } from "../src/queue";
import { makeTestDeps, DUMMY_ENV, req, fakeBatch, type TestDeps } from "./helpers";

const ADMIN = "usr_admin";
const READER = "usr_reader";
const NOBODY = "usr_nobody";

const PERMS: Record<string, string[]> = {
  [ADMIN]: ["infra:read", "infra:deploy", "infra:dns", "infra:admin"],
  [READER]: ["infra:read"],
  [NOBODY]: [],
};

function appWith(deps: TestDeps) {
  return createApp(() => deps);
}

async function seedSite(deps: TestDeps, name = "public-hp") {
  return deps.repo.createSite({
    name,
    domain: null,
    cfProjectName: name,
    zoneId: null,
    defaultBranch: "main",
    createdBy: ADMIN,
  });
}

describe("sites", () => {
  let deps: TestDeps;
  beforeEach(() => {
    deps = makeTestDeps({ perms: PERMS });
  });

  it("creates a site (infra:admin) and lists it", async () => {
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/sites", { method: "POST", userId: ADMIN, body: { name: "public-lp" } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(201);
    const site = (await res.json()) as deploy.Site;
    expect(Object.keys(site).sort()).toEqual(["createdAt", "domain", "id", "name"]);
    expect(site.name).toBe("public-lp");

    const listRes = await app.fetch(req("/deploy/sites", { userId: READER }), DUMMY_ENV);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: deploy.Site[] };
    expect(list.items).toHaveLength(1);
  });

  it("rejects duplicate site name with 409", async () => {
    await seedSite(deps, "dup");
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/sites", { method: "POST", userId: ADMIN, body: { name: "dup" } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(409);
  });

  it("rejects site create without infra:admin (403)", async () => {
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/sites", { method: "POST", userId: READER, body: { name: "nope" } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(403);
    expect(deps.repo.sites).toHaveLength(0);
  });

  it("validation: missing name -> 400", async () => {
    const app = appWith(deps);
    const res = await app.fetch(req("/deploy/sites", { method: "POST", userId: ADMIN, body: {} }), DUMMY_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
  });
});

describe("deployments (POST = async 202)", () => {
  let deps: TestDeps;
  beforeEach(() => {
    deps = makeTestDeps({ perms: PERMS });
  });

  // design test #1
  it("accepts a deployment: 202, queued row, write-ahead intent, job enqueued", async () => {
    const site = await seedSite(deps);
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id, commitSha: "abc123" } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(202);
    const dep = (await res.json()) as deploy.Deployment;
    expect(Object.keys(dep).sort()).toEqual(["commitSha", "createdAt", "id", "siteId", "status", "updatedAt"]);
    expect(dep.status).toBe("queued");

    expect(deps.repo.deployments).toHaveLength(1);
    // intent recorded BEFORE enqueue, with the frozen sync action name
    expect(deps.audit.recordIntent).toHaveBeenCalledTimes(1);
    expect(deps.audit.intents[0]!.action).toBe("infra.deploy.executed");
    // job enqueued for async execution
    expect(deps.jobs).toHaveLength(1);
    expect(deps.jobs[0]!.kind).toBe("execute");
    expect(deps.jobs[0]!.deploymentId).toBe(dep.id);
    expect(deps.jobs[0]!.intentId).toBe("aud_intent_1");
  });

  // design test #4
  it("returns 409 when a deployment is already in flight for the site", async () => {
    const site = await seedSite(deps);
    const app = appWith(deps);
    const first = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    expect(first.status).toBe(202);
    const second = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    expect(second.status).toBe(409);
    expect(deps.repo.deployments).toHaveLength(1);
  });

  // design test #5
  it("rejects without infra:deploy: 403, no CF call, no audit intent", async () => {
    const site = await seedSite(deps);
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: READER, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(403);
    expect(deps.audit.recordIntent).not.toHaveBeenCalled();
    expect(deps.cf.createPagesDeployment).not.toHaveBeenCalled();
    expect(deps.jobs).toHaveLength(0);
  });

  it("404 for unknown site", async () => {
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: "site_missing" } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("GET list + detail conform to the frozen contract", async () => {
    const site = await seedSite(deps);
    const app = appWith(deps);
    await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    const listRes = await app.fetch(req(`/deploy/deployments?siteId=${site.id}`, { userId: READER }), DUMMY_ENV);
    expect(listRes.status).toBe(200);
    const page = (await listRes.json()) as deploy.ListDeploymentsResponse;
    expect(page.items).toHaveLength(1);
    expect(page).toHaveProperty("nextCursor");

    const id = page.items[0]!.id;
    const detailRes = await app.fetch(req(`/deploy/deployments/${id}`, { userId: READER }), DUMMY_ENV);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as deploy.Deployment;
    expect(detail.id).toBe(id);

    const missing = await app.fetch(req(`/deploy/deployments/dep_nope`, { userId: READER }), DUMMY_ENV);
    expect(missing.status).toBe(404);
  });

  it("rejects invalid status filter with 400", async () => {
    const app = appWith(deps);
    const res = await app.fetch(req(`/deploy/deployments?status=bogus`, { userId: READER }), DUMMY_ENV);
    expect(res.status).toBe(400);
  });
});

describe("deploy-jobs consumer (async CF execution)", () => {
  // design test #2
  it("CF success -> status live, status_changed events, result audit linked to intent", async () => {
    const deps = makeTestDeps({
      perms: PERMS,
      cf: { pagesResult: { cfDeploymentId: "cfdep_9", status: "live", url: "https://hp.pages.dev" } },
    });
    const site = await seedSite(deps);
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    const dep = (await res.json()) as deploy.Deployment;

    const { batch, acks } = fakeBatch(deps.jobs);
    await handleDeployJobs(batch as never, DUMMY_ENV, () => deps);

    const row = await deps.repo.getDeployment(dep.id);
    expect(row!.status).toBe("live");
    expect(row!.url).toBe("https://hp.pages.dev");
    expect(acks).toEqual([0]);

    const statuses = deps.events.events.filter((e) => e.kind === "deployment").map((e) => e.payload.status);
    expect(statuses).toContain("building");
    expect(statuses).toContain("live");

    expect(deps.audit.results).toHaveLength(1);
    expect(deps.audit.results[0]!.result).toBe("success");
    expect(deps.audit.results[0]!.intentId).toBe("aud_intent_1");
  });

  // design test #3
  it("CF failure -> status failed, error stored, failure event + failure result audit", async () => {
    const deps = makeTestDeps({
      perms: PERMS,
      cf: { pagesThrows: new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "cf down", { status: 502 }) },
    });
    const site = await seedSite(deps);
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    const dep = (await res.json()) as deploy.Deployment;

    const { batch, acks } = fakeBatch(deps.jobs);
    await handleDeployJobs(batch as never, DUMMY_ENV, () => deps);

    const row = await deps.repo.getDeployment(dep.id);
    expect(row!.status).toBe("failed");
    expect(row!.errorMessage).toContain("cf down");
    expect(acks).toEqual([0]);

    const failEvent = deps.events.events.find((e) => e.kind === "deployment" && e.payload.status === "failed");
    expect(failEvent).toBeTruthy();
    expect(deps.audit.results[0]!.result).toBe("failure");
  });

  it("building CF result schedules a poll job", async () => {
    const deps = makeTestDeps({
      perms: PERMS,
      cf: { pagesResult: { cfDeploymentId: "cfdep_b", status: "building", url: null } },
    });
    const site = await seedSite(deps);
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    const dep = (await res.json()) as deploy.Deployment;
    const executeJobs = [...deps.jobs];
    deps.jobs.length = 0;

    const { batch } = fakeBatch(executeJobs);
    await handleDeployJobs(batch as never, DUMMY_ENV, () => deps);

    const row = await deps.repo.getDeployment(dep.id);
    expect(row!.status).toBe("building");
    expect(deps.jobs).toHaveLength(1);
    expect(deps.jobs[0]!.kind).toBe("poll");
    // no result audit yet (not terminal)
    expect(deps.audit.results).toHaveLength(0);
  });
});

describe("dns records", () => {
  let deps: TestDeps;
  beforeEach(() => {
    deps = makeTestDeps({ perms: PERMS });
    deps.repo.allowedZones.push({ zoneId: "zone_hp", zoneName: "developershub.jp", registrarManaged: true });
  });

  // design test #8
  it("creates a DNS record in an allowed zone: CF payload, history, event, result audit", async () => {
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/dns/records", {
        method: "POST",
        userId: ADMIN,
        body: { zone: "zone_hp", type: "CNAME", name: "www.developershub.jp", content: "hp.pages.dev" },
      }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(201);
    expect(deps.audit.recordIntent).toHaveBeenCalledTimes(1);
    expect(deps.audit.intents[0]!.action).toBe("infra.dns.changed");
    expect(deps.cf.createDnsRecord).toHaveBeenCalledTimes(1);
    expect(deps.repo.dnsChanges[0]!.status).toBe("applied");
    const dnsEvent = deps.events.events.find((e) => e.kind === "dns");
    expect(dnsEvent!.payload).toEqual({ zone: "zone_hp", name: "www.developershub.jp" });
    expect(deps.audit.results[0]!.result).toBe("success");
  });

  // design test #6
  it("rejects a disallowed zone: 403, no intent audit, no CF call", async () => {
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/dns/records", {
        method: "POST",
        userId: ADMIN,
        body: { zone: "evil.example", type: "A", name: "x.evil.example", content: "1.2.3.4" },
      }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(403);
    expect(deps.audit.recordIntent).not.toHaveBeenCalled();
    expect(deps.cf.createDnsRecord).not.toHaveBeenCalled();
  });

  // design test #7 (fail-close)
  it("audit intent failure -> 502 and CF is never called", async () => {
    const failing = makeTestDeps({
      perms: PERMS,
      audit: { intentThrows: new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "audit down", { status: 502 }) },
    });
    failing.repo.allowedZones.push({ zoneId: "zone_hp", zoneName: "developershub.jp", registrarManaged: true });
    const app = appWith(failing);
    const res = await app.fetch(
      req("/deploy/dns/records", {
        method: "POST",
        userId: ADMIN,
        body: { zone: "zone_hp", type: "A", name: "a.developershub.jp", content: "1.2.3.4" },
      }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(502);
    expect(failing.cf.createDnsRecord).not.toHaveBeenCalled();
    expect(failing.repo.dnsChanges).toHaveLength(0);
  });

  it("CF failure -> history failed + failure result audit, then 502", async () => {
    const failing = makeTestDeps({
      perms: PERMS,
      cf: { dnsThrows: new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "cf dns down", { status: 502 }) },
    });
    failing.repo.allowedZones.push({ zoneId: "zone_hp", zoneName: "developershub.jp", registrarManaged: true });
    const app = appWith(failing);
    const res = await app.fetch(
      req("/deploy/dns/records", {
        method: "POST",
        userId: ADMIN,
        body: { zone: "zone_hp", type: "A", name: "a.developershub.jp", content: "1.2.3.4" },
      }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(502);
    expect(failing.repo.dnsChanges[0]!.status).toBe("failed");
    expect(failing.audit.results[0]!.result).toBe("failure");
  });

  it("rejects invalid record type with 400", async () => {
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/dns/records", {
        method: "POST",
        userId: ADMIN,
        body: { zone: "zone_hp", type: "SRV", name: "x", content: "y" },
      }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(400);
  });
});

describe("domains", () => {
  // design test #9
  it("merges CF zones with the allowed-zone table", async () => {
    const deps = makeTestDeps({
      perms: PERMS,
      cf: {
        zones: [
          { zoneId: "zone_hp", zoneName: "developershub.jp", status: "active", registrarManaged: true },
          { zoneId: "zone_x", zoneName: "other.example", status: "active", registrarManaged: false },
        ],
      },
    });
    deps.repo.allowedZones.push({ zoneId: "zone_hp", zoneName: "developershub.jp", registrarManaged: true });
    const app = appWith(deps);
    const res = await app.fetch(req("/deploy/domains", { userId: READER }), DUMMY_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: deploy.Domain[] };
    const hp = body.items.find((d) => d.name === "developershub.jp");
    const other = body.items.find((d) => d.name === "other.example");
    expect(hp!.verified).toBe(true);
    expect(other!.verified).toBe(false);
  });
});

describe("authz single-layer (design test #10)", () => {
  it("every change op consults identity /authz/check", async () => {
    const deps = makeTestDeps({ perms: PERMS });
    const site = await seedSite(deps);
    const app = appWith(deps);
    await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: ADMIN, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    expect(deps.identityCalls.length).toBeGreaterThan(0);
    expect(deps.identityCalls.some((c) => c.checks.some((q) => q.permission === "infra:deploy"))).toBe(true);
  });

  it("denies a user with no permissions (403)", async () => {
    const deps = makeTestDeps({ perms: PERMS });
    const site = await seedSite(deps);
    const app = appWith(deps);
    const res = await app.fetch(
      req("/deploy/deployments", { method: "POST", userId: NOBODY, body: { siteId: site.id } }),
      DUMMY_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("missing x-dub-user-id -> 401", async () => {
    const deps = makeTestDeps({ perms: PERMS });
    const app = appWith(deps);
    const res = await app.fetch(req("/deploy/sites", { method: "POST", body: { name: "x" } }), DUMMY_ENV);
    expect(res.status).toBe(401);
  });
});
