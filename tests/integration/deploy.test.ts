// End-to-end coverage of deploy-service's 7 endpoints through the REAL api-gateway
// and the REAL identity-roster RBAC (admin => full infra:*, organizer => infra:read,
// member => none). The deploy-service is wired as the REAL Hono app in the harness
// (SVC_DEPLOY = buildDeploy), with a fake CF control plane that settles Pages deploys
// `live` on the first async pass and a seeded allowed zone `devhub.test`. This is the
// suite that flips the former "inert SVC_DEPLOY skeleton" into exercised routes.
import { describe, it, expect } from "vitest";
import { createHarness } from "../lib/harness";
import type { deploy } from "@dub/types";

describe("deploy-service e2e: sites", () => {
  it("admin registers a site (201) and organizer lists it (200)", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const organizer = await h.login("organizer");

    const created = await h.gw("POST", "/api/v1/deploy/sites", {
      token: admin,
      body: { name: "devhub-landing", domain: "devhub.test" },
    });
    expect(created.status).toBe(201);
    const site = created.json<deploy.Site>();
    expect(Object.keys(site).sort()).toEqual(["createdAt", "domain", "id", "name"]);
    expect(site.name).toBe("devhub-landing");

    const list = await h.gw("GET", "/api/v1/deploy/sites", { token: organizer });
    expect(list.status).toBe(200);
    const items = list.json<{ items: deploy.Site[] }>().items;
    expect(items.some((s) => s.id === site.id)).toBe(true);
  });

  it("duplicate site name -> 409", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    await h.gw("POST", "/api/v1/deploy/sites", { token: admin, body: { name: "dup" } });
    const again = await h.gw("POST", "/api/v1/deploy/sites", { token: admin, body: { name: "dup" } });
    expect(again.status).toBe(409);
  });

  it("missing name -> 400 VALIDATION_FAILED", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const res = await h.gw("POST", "/api/v1/deploy/sites", { token: admin, body: {} });
    expect(res.status).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
  });

  it("member (no infra:admin) cannot register a site -> 403", async () => {
    const h = await createHarness();
    const member = await h.login("member");
    const res = await h.gw("POST", "/api/v1/deploy/sites", { token: member, body: { name: "nope" } });
    expect(res.status).toBe(403);
  });
});

describe("deploy-service e2e: deployments (async 202 -> live)", () => {
  async function seedSite(h: Awaited<ReturnType<typeof createHarness>>, admin: string): Promise<string> {
    const res = await h.gw("POST", "/api/v1/deploy/sites", { token: admin, body: { name: "app-" + Math.random().toString(36).slice(2, 8) } });
    return res.json<deploy.Site>().id;
  }

  it("queues a deployment (202 queued) then settles live, observable via GET + list", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const organizer = await h.login("organizer");
    const siteId = await seedSite(h, admin);

    const create = await h.gw("POST", "/api/v1/deploy/deployments", {
      token: admin,
      body: { siteId, commitSha: "9f1c2ab" },
    });
    expect(create.status).toBe(202);
    const dep = create.json<deploy.Deployment>();
    expect(dep.status).toBe("queued"); // the wire body is still queued on accept
    expect(Object.keys(dep).sort()).toEqual(["commitSha", "createdAt", "id", "siteId", "status", "updatedAt"]);

    // the private deploy-jobs queue was drained in-process by the harness; the fake
    // CF settled the Pages deploy `live`.
    const get = await h.gw("GET", `/api/v1/deploy/deployments/${dep.id}`, { token: organizer });
    expect(get.status).toBe(200);
    expect(get.json<deploy.Deployment>().status).toBe("live");

    const list = await h.gw("GET", `/api/v1/deploy/deployments?siteId=${siteId}`, { token: organizer });
    expect(list.status).toBe(200);
    const page = list.json<deploy.ListDeploymentsResponse>();
    expect(page).toHaveProperty("nextCursor");
    expect(page.items.some((d) => d.id === dep.id && d.status === "live")).toBe(true);

    // write-ahead intent + terminal result audit both landed in the shared audit store.
    const deployAudits = h.stores.audit.filter((a) => a.action === "infra.deploy.executed");
    expect(deployAudits.some((a) => a.result === "intent")).toBe(true);
    expect(deployAudits.some((a) => a.result === "success")).toBe(true);
  });

  it("organizer (infra:read only) cannot queue a deployment -> 403", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const organizer = await h.login("organizer");
    const siteId = await seedSite(h, admin);
    const res = await h.gw("POST", "/api/v1/deploy/deployments", { token: organizer, body: { siteId } });
    expect(res.status).toBe(403);
  });

  it("unknown site -> 404, invalid status filter -> 400, unknown id -> 404", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const missing = await h.gw("POST", "/api/v1/deploy/deployments", { token: admin, body: { siteId: "site_missing" } });
    expect(missing.status).toBe(404);

    const badFilter = await h.gw("GET", "/api/v1/deploy/deployments?status=bogus", { token: admin });
    expect(badFilter.status).toBe(400);

    const badId = await h.gw("GET", "/api/v1/deploy/deployments/dep_nope", { token: admin });
    expect(badId.status).toBe(404);
  });
});

describe("deploy-service e2e: dns records", () => {
  it("creates a record in the allowed zone (201) and echoes the CF record", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const res = await h.gw("POST", "/api/v1/deploy/dns/records", {
      token: admin,
      body: { zone: "devhub.test", type: "CNAME", name: "www", content: "devhub-landing.pages.dev" },
    });
    expect(res.status).toBe(201);
    const rec = res.json<{ id: string; zone: string; type: string; name: string; content: string }>();
    expect(rec).toMatchObject({ zone: "devhub.test", type: "CNAME", name: "www", content: "devhub-landing.pages.dev" });
    expect(rec.id).toBeTruthy();
    expect(h.stores.audit.some((a) => a.action === "infra.dns.changed" && a.result === "success")).toBe(true);
  });

  it("disallowed zone -> 403 before any audit/CF (allow-list barrier)", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const res = await h.gw("POST", "/api/v1/deploy/dns/records", {
      token: admin,
      body: { zone: "evil.example", type: "A", name: "x", content: "1.2.3.4" },
    });
    expect(res.status).toBe(403);
    expect(h.stores.audit.some((a) => a.action === "infra.dns.changed")).toBe(false);
  });

  it("invalid record type -> 400", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const res = await h.gw("POST", "/api/v1/deploy/dns/records", {
      token: admin,
      body: { zone: "devhub.test", type: "SRV", name: "x", content: "y" },
    });
    expect(res.status).toBe(400);
  });

  it("member (no infra:dns) -> 403", async () => {
    const h = await createHarness();
    const member = await h.login("member");
    const res = await h.gw("POST", "/api/v1/deploy/dns/records", {
      token: member,
      body: { zone: "devhub.test", type: "A", name: "x", content: "1.2.3.4" },
    });
    expect(res.status).toBe(403);
  });
});

describe("deploy-service e2e: domains + auth boundary", () => {
  it("lists zones with the allow-list flag (200)", async () => {
    const h = await createHarness();
    const organizer = await h.login("organizer");
    const res = await h.gw("GET", "/api/v1/deploy/domains", { token: organizer });
    expect(res.status).toBe(200);
    const items = res.json<{ items: deploy.Domain[] }>().items;
    const devhub = items.find((d) => d.name === "devhub.test");
    expect(devhub?.verified).toBe(true);
  });

  it("no token -> 401 at the gateway", async () => {
    const h = await createHarness();
    const res = await h.gw("GET", "/api/v1/deploy/sites");
    expect(res.status).toBe(401);
  });
});
