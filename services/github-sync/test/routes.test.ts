import { describe, it, expect } from "vitest";
import { DubError } from "@dub/errors";
import type { AuthClient } from "@dub/auth-client";
import type { GithubRepoConfig } from "../src/domain/types";
import { createApp } from "../src/app";
import { makeHarness, issue, fixedNow, type Harness } from "./helpers";

function fakeAuth(): AuthClient {
  return {
    requireAuth: () => async (c: any, next: any) => {
      const uid = c.req.header("x-dub-user-id");
      if (!uid) throw new DubError("AUTH_INVALID_TOKEN", "no user", { status: 401 });
      c.set("authn", { userId: uid, source: "trusted_header", session: null });
      await next();
    },
    requirePermission: () => async (c: any, next: any) => {
      if (c.req.header("x-deny")) throw new DubError("FORBIDDEN", "denied", { status: 403 });
      await next();
    },
    verify: async () => {
      throw new Error("unused");
    },
    checkPermissions: async () => ({ decisions: [] }),
    hasPermission: async () => true,
    invalidateAuthzCache: () => {},
  } as unknown as AuthClient;
}

function app(h: Harness) {
  const webhookRaw = { get: async () => null } as unknown as import("@cloudflare/workers-types").R2Bucket;
  return createApp({
    auth: fakeAuth(),
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

  it("401 when the trusted user header is absent", async () => {
    const h = makeHarness();
    const res = await app(h).fetch(new Request("https://svc/github/links", { headers: { "x-dub-request-id": "r" } }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("AUTH_INVALID_TOKEN");
  });

  it("403 when permission is denied", async () => {
    const h = makeHarness();
    const res = await app(h).fetch(new Request("https://svc/github/links", { headers: headers({ "x-deny": "1" }) }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("FORBIDDEN");
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
