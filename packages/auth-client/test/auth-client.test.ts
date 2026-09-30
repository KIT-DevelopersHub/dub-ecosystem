import { describe, it, expect, vi } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { Context } from "hono";
import type { identity } from "@dub/types";
import { createAuthClient, getAuthn } from "../src/index";

// identity fetcher fake: responds with decisions from a scripted function.
function identityFake(respond: (req: identity.AuthzCheckRequest, callN: number) => identity.AuthzDecision[] | { status: number }) {
  let n = 0;
  const calls: identity.AuthzCheckRequest[] = [];
  const fetcher = {
    fetch: async (req: Request) => {
      n++;
      const body = (await req.json()) as identity.AuthzCheckRequest;
      calls.push(body);
      const out = respond(body, n);
      if ("status" in out) return new Response("err", { status: out.status });
      const res: identity.AuthzCheckResponse = { decisions: out };
      return new Response(JSON.stringify(res), { status: 200 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls, get n() { return n; } };
}

const allow = (ttl = 60): identity.AuthzDecision => ({ allowed: true, evaluatedAt: "2026-08-09T00:00:00Z", ttlSeconds: ttl });
const deny = (ttl = 60): identity.AuthzDecision => ({ allowed: false, evaluatedAt: "2026-08-09T00:00:00Z", ttlSeconds: ttl });

describe("@dub/auth-client checkPermissions cache", () => {
  it("all-miss -> 1 call, all-hit -> 0 calls", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "task-service" });
    const req: identity.AuthzCheckRequest = { subjectUserId: "u1", orgId: "org_devhub", checks: [{ permission: "task:read" }] };
    expect((await client.checkPermissions(req)).decisions[0]?.allowed).toBe(true);
    expect(idf.n).toBe(1);
    await client.checkPermissions(req); // cached
    expect(idf.n).toBe(1);
  });

  it("partial hit -> only misses queried and merged in order", async () => {
    const idf = identityFake((body) => body.checks.map((c) => (c.permission === "task:read" ? allow() : deny())));
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    await client.checkPermissions({ subjectUserId: "u1", orgId: "o", checks: [{ permission: "task:read" }] });
    expect(idf.n).toBe(1);
    const res = await client.checkPermissions({ subjectUserId: "u1", orgId: "o", checks: [{ permission: "task:read" }, { permission: "task:write" }] });
    expect(idf.n).toBe(2);
    expect(idf.calls[1]!.checks.map((c) => c.permission)).toEqual(["task:write"]); // only the miss
    expect(res.decisions.map((d) => d.allowed)).toEqual([true, false]); // order preserved
  });

  it("deny is cached too", async () => {
    const idf = identityFake(() => [deny()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const req: identity.AuthzCheckRequest = { subjectUserId: "u1", orgId: "o", checks: [{ permission: "task:read" }] };
    await client.checkPermissions(req);
    await client.checkPermissions(req);
    expect(idf.n).toBe(1);
  });

  it("fresh:true bypasses cache (read+write)", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const req: identity.AuthzCheckRequest = { subjectUserId: "u1", orgId: "o", checks: [{ permission: "task:read" }] };
    await client.checkPermissions(req, { fresh: true });
    await client.checkPermissions(req, { fresh: true });
    expect(idf.n).toBe(2);
  });

  it("dangerous keys are never cached (always sync check)", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const req: identity.AuthzCheckRequest = { subjectUserId: "u1", orgId: "o", checks: [{ permission: "infra:deploy" }] };
    await client.checkPermissions(req);
    await client.checkPermissions(req);
    expect(idf.n).toBe(2);
  });

  it("TTL expiry triggers re-query", async () => {
    vi.useFakeTimers();
    const idf = identityFake(() => [allow(1)]); // 1s TTL
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const req: identity.AuthzCheckRequest = { subjectUserId: "u1", orgId: "o", checks: [{ permission: "task:read" }] };
    await client.checkPermissions(req);
    vi.advanceTimersByTime(1500);
    await client.checkPermissions(req);
    expect(idf.n).toBe(2);
    vi.useRealTimers();
  });

  it("batch bounds: 0 or 21 checks -> VALIDATION_FAILED (no identity call)", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    await expect(client.checkPermissions({ subjectUserId: "u1", orgId: "o", checks: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const many = Array.from({ length: 21 }, () => ({ permission: "task:read" as const }));
    await expect(client.checkPermissions({ subjectUserId: "u1", orgId: "o", checks: many })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(idf.n).toBe(0);
  });

  it("fail-closed: identity 500 propagates (never resolves to allow)", async () => {
    const idf = identityFake(() => ({ status: 500 }));
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    await expect(client.hasPermission("u1", "o", { permission: "task:read" }, { fresh: true })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("invalidateAuthzCache(userId) forces re-query for that user only", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    await client.hasPermission("u1", "o", { permission: "task:read" });
    await client.hasPermission("u2", "o", { permission: "task:read" });
    expect(idf.n).toBe(2);
    client.invalidateAuthzCache("u1");
    await client.hasPermission("u1", "o", { permission: "task:read" }); // re-query
    await client.hasPermission("u2", "o", { permission: "task:read" }); // still cached
    expect(idf.n).toBe(3);
  });
});

// minimal Hono context stub
function fakeCtx(headers: Record<string, string>): { c: Context; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const c = {
    req: { header: (h: string) => headers[h.toLowerCase()] },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
  } as unknown as Context;
  return { c, store };
}

describe("@dub/auth-client middleware", () => {
  it("requireAuth (trustedHeader) sets authn from x-dub-user-id", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const { c } = fakeCtx({ "x-dub-user-id": "u1" });
    const next = vi.fn(async () => {});
    await client.requireAuth()(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(getAuthn(c)).toEqual({ userId: "u1", source: "trusted_header", session: null });
  });

  it("requireAuth throws AUTH_INVALID_TOKEN when header absent", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const { c } = fakeCtx({});
    await expect(client.requireAuth()(c, async () => {})).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN", status: 401 });
  });

  it("requirePermission allows then denies via FORBIDDEN", async () => {
    const idf = identityFake((body) => body.checks.map((c) => (c.permission === "task:write" ? allow() : deny())));
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const { c } = fakeCtx({ "x-dub-user-id": "u1" });
    await client.requireAuth()(c, async () => {});

    const next = vi.fn(async () => {});
    await client.requirePermission("task:write")(c, next);
    expect(next).toHaveBeenCalledOnce();

    await expect(client.requirePermission("task:read")(c, async () => {})).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});

// ── policy enforcement (requireAppAccess) ─────────────────────────────────────
// The per-app 3-tier (無効/閲覧/編集) becomes authoritative server-side here. These tests pin
// the two properties services rely on: ONE batched round-trip, and a 403 that says WHY.
describe("@dub/auth-client requireAppAccess (policy PEP)", () => {
  async function authed(granted: readonly string[]) {
    const idf = identityFake((body) => body.checks.map((q) => (granted.includes(q.permission) ? allow() : deny())));
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const { c } = fakeCtx({ "x-dub-user-id": "u1" });
    await client.requireAuth()(c, async () => {});
    return { client, c, idf };
  }

  it("閲覧 passes a view requirement in ONE identity call (both keys batched)", async () => {
    const { client, c, idf } = await authed(["app:tasks:view"]);
    const next = vi.fn(async () => {});
    await client.requireAppAccess("tasks", "view")(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(idf.n).toBe(1);
    expect(idf.calls[0]!.checks.map((q) => q.permission)).toEqual(["app:tasks:view"]);
  });

  it("編集 requirement batches view+edit into ONE call", async () => {
    const { client, c, idf } = await authed(["app:tasks:view", "app:tasks:edit"]);
    const next = vi.fn(async () => {});
    await client.requireAppAccess("tasks", "edit")(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(idf.n).toBe(1);
    expect(idf.calls[0]!.checks.map((q) => q.permission)).toEqual(["app:tasks:view", "app:tasks:edit"]);
  });

  it("閲覧のみ のロールが書き込みを叩くと 403 (reason=read_only)", async () => {
    const { client, c } = await authed(["app:tasks:view"]);
    await expect(client.requireAppAccess("tasks", "edit")(c, async () => {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      details: [{ field: "app", reason: "read_only" }],
    });
  });

  it("無効 のアプリは閲覧すら 403 (reason=app_disabled)", async () => {
    const { client, c } = await authed([]);
    await expect(client.requireAppAccess("tasks", "view")(c, async () => {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: [{ field: "app", reason: "app_disabled" }],
    });
  });

  it("AND-checks an extra fine-grained key (level alone is not enough)", async () => {
    const { client, c } = await authed(["app:chat:view", "app:chat:edit"]);
    await expect(
      client.requireAppAccess("chat", "edit", { permission: "chat:moderate" })(c, async () => {}),
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: [{ field: "app", reason: "missing_permission" }] });

    const ok = await authed(["app:chat:view", "app:chat:edit", "chat:moderate"]);
    const next = vi.fn(async () => {});
    await ok.client.requireAppAccess("chat", "edit", { permission: "chat:moderate" })(ok.c, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed for an unregistered app id (no keys => no silent allow)", async () => {
    const { client, c, idf } = await authed(["app:tasks:edit"]);
    await expect(client.requireAppAccess("ghost-app", "view")(c, async () => {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: [{ field: "app", reason: "unknown_app" }],
    });
    expect(idf.n).toBe(0); // nothing to ask identity about
  });

  it("requires requireAuth first", async () => {
    const idf = identityFake(() => [allow()]);
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const { c } = fakeCtx({});
    await expect(client.requireAppAccess("tasks", "view")(c, async () => {})).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      status: 401,
    });
  });

  it("appAccessLevel reports the caller's tier for response shaping", async () => {
    const viewer = await authed(["app:mail:view"]);
    expect(await viewer.client.appAccessLevel("u1", "org_devhub", "mail")).toBe("view");
    const editor = await authed(["app:mail:view", "app:mail:edit"]);
    expect(await editor.client.appAccessLevel("u1", "org_devhub", "mail")).toBe("edit");
    const none = await authed([]);
    expect(await none.client.appAccessLevel("u1", "org_devhub", "mail")).toBe("none");
  });

  it("fail-closed: identity transport failure propagates (never allows)", async () => {
    const idf = identityFake(() => ({ status: 500 }));
    const client = createAuthClient({ identityBinding: idf.fetcher, serviceName: "svc" });
    const { c } = fakeCtx({ "x-dub-user-id": "u1" });
    await client.requireAuth()(c, async () => {});
    await expect(client.requireAppAccess("tasks", "edit")(c, async () => {})).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});
