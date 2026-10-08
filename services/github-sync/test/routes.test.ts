// Authn/authz here is @dub/policy-gate over src/policy-table.ts — there is no auth
// middleware left to fake, only the PermissionGranter port (see ./helpers).
import { describe, it, expect } from "vitest";
import type { PermissionGranter } from "@dub/policy-gate";
import type { GithubRepoConfig } from "../src/domain/types";
import { createApp } from "../src/app";
import { makeHarness, issue, fixedNow, allowAll, denyAll, type Harness } from "./helpers";

function app(h: Harness, authz: PermissionGranter = allowAll) {
  const webhookRaw = { get: async () => null } as unknown as import("@cloudflare/workers-types").R2Bucket;
  return createApp({
    authz,
    service: h.service,
    publisher: h.publisher,
    now: fixedNow,
    queue: { engine: h.engine, processed: h.stores.processed, webhookRaw },
  });
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return { "x-dub-request-id": "req_test", "x-dub-user-id": "user_1", "content-type": "application/json", ...extra };
}

async function seedRepo(h: Harness, over?: Partial<GithubRepoConfig>): Promise<GithubRepoConfig> {
  const r: GithubRepoConfig = {
    id: "ghr_main", owner: "acme", repo: "web", eventId: "evt_1", defaultActionId: null,
    origin: "github", direction: "bidirectional", enabled: true, installationId: null,
    projectNumber: null, labelFilter: [], createdBy: "user_1", createdAt: fixedNow(), updatedAt: fixedNow(),
    ...over,
  };
  await h.stores.repos.create(r);
  return r;
}

describe("HTTP routes", () => {
  it("400 when x-dub-request-id is absent", async () => {
    const h = makeHarness();
    const res = await app(h).fetch(new Request("https://svc/github/links", { headers: { "x-dub-user-id": "user_1" } }));
    expect(res.status).toBe(400);
  });

  // The gate is mounted before dubContext, so authn now answers first: a request with no
  // x-dub-user-id is 401 UNAUTHENTICATED (policyGate) rather than the old AuthClient's
  // AUTH_INVALID_TOKEN. Same status, the code is now the common wire code.
  it("401 when the trusted user header is absent", async () => {
    const h = makeHarness();
    const res = await app(h).fetch(new Request("https://svc/github/links", { headers: { "x-dub-request-id": "r" } }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("403 when permission is denied", async () => {
    const h = makeHarness();
    const res = await app(h, denyAll).fetch(new Request("https://svc/github/links", { headers: headers() }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details).toMatchObject({ reason: "missing_permission", missing: ["github:read"] });
  });

  it("GET /github/links returns a paginated envelope", async () => {
    const h = makeHarness();
    const res = await app(h).fetch(new Request("https://svc/github/links", { headers: headers() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("POST /github/links returns 201 with the frozen GithubLink shape", async () => {
    const h = makeHarness();
    await seedRepo(h);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 42 }));
    const res = await app(h).fetch(
      new Request("https://svc/github/links", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ taskId: "task_z", owner: "acme", repo: "web", issueNumber: 42 }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body).toEqual({
      taskId: "task_z",
      repo: "acme/web",
      issueNumber: 42,
      url: "https://github.com/acme/web/issues/42",
      linkedAt: fixedNow(),
    });
  });

  it("POST /github/sync returns 202 and records an audit", async () => {
    const h = makeHarness();
    const res = await app(h).fetch(
      new Request("https://svc/github/sync", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ scope: "all" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.status).toBe("succeeded");
    expect(h.publisher.audits.length).toBe(1);
  });

  it("GET /github/sync/runs/:id returns 404 for unknown ids in ErrorResponse form", async () => {
    const h = makeHarness();
    const res = await app(h).fetch(new Request("https://svc/github/sync/runs/ghs_nope", { headers: headers() }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.retryable).toBe("boolean");
  });
});
