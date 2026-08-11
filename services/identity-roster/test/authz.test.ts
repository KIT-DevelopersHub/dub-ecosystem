import { describe, it, expect } from "vitest";
import { isDubError } from "@dub/errors";
import type { identity } from "@dub/types";
import { IdentityService } from "../src/service";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { FakeAudit, FakeRevoker, makeHarness, internal, jsonBody } from "./harness";

const ORG = "org_devhub";
const TS = "2026-08-09T00:00:00.000Z";

function build() {
  const repo = new MemIdentityRepo();
  let n = 0;
  const deps = { repo, audit: new FakeAudit(), revoker: new FakeRevoker(), now: () => TS, newId: (p: string) => `${p}_${++n}`, defaultOrgId: ORG };
  return { repo, svc: new IdentityService(deps) };
}

async function seedRole(repo: MemIdentityRepo, id: string, perms: identity.PermissionKey[]) {
  await repo.createRole({ id, orgId: ORG, name: id, isSystem: false, permissions: perms, createdAt: TS, updatedAt: TS });
}
async function seedUser(repo: MemIdentityRepo, id: string, status: identity.UserStatus = "active", orgId = ORG) {
  await repo.createUser({ id, orgId, email: `${id}@x.jp`, displayName: id, githubLogin: null, avatarUrl: null, status, source: "manual", createdAt: TS, updatedAt: TS });
}
async function assign(repo: MemIdentityRepo, id: string, userId: string, roleId: string, rt: string | null = null, ri: string | null = null) {
  await repo.createAssignment({ id, userId, roleId, orgId: ORG, resourceType: rt, resourceId: ri, grantedBy: "sys", grantedAt: TS });
}

describe("authz evaluation semantics", () => {
  it("org-wide role grants the permission", async () => {
    const { repo, svc } = build();
    await seedRole(repo, "r_read", ["identity:read"]);
    await seedUser(repo, "u1");
    await assign(repo, "a1", "u1", "r_read");
    expect(await svc.can("u1", ORG, { permission: "identity:read" })).toBe(true);
    expect(await svc.can("u1", ORG, { permission: "identity:admin" })).toBe(false); // not granted
  });

  it("resource-scoped assignment allows only the matching resource", async () => {
    const { repo, svc } = build();
    await seedRole(repo, "r_ev", ["event:write"]);
    await seedUser(repo, "u1");
    await assign(repo, "a1", "u1", "r_ev", "event", "ev_1");
    expect(await svc.can("u1", ORG, { permission: "event:write", resourceType: "event", resourceId: "ev_1" })).toBe(true);
    // same type, different id -> denied
    expect(await svc.can("u1", ORG, { permission: "event:write", resourceType: "event", resourceId: "ev_2" })).toBe(false);
    // scoped grant does not satisfy an org-wide query
    expect(await svc.can("u1", ORG, { permission: "event:write" })).toBe(false);
  });

  it("denies non-catalog permission keys (default deny)", async () => {
    const { repo, svc } = build();
    await seedRole(repo, "r", ["identity:read"]);
    await seedUser(repo, "u1");
    await assign(repo, "a1", "u1", "r");
    expect(await svc.can("u1", ORG, { permission: "made:up" as identity.PermissionKey })).toBe(false);
  });

  it("denies a disabled user everything", async () => {
    const { repo, svc } = build();
    await seedRole(repo, "r", ["identity:read"]);
    await seedUser(repo, "u1", "disabled");
    await assign(repo, "a1", "u1", "r");
    expect(await svc.can("u1", ORG, { permission: "identity:read" })).toBe(false);
  });

  it("denies when the subject is not a member of the queried org", async () => {
    const { repo, svc } = build();
    await seedRole(repo, "r", ["identity:read"]);
    await seedUser(repo, "u1", "active", "org_other");
    await assign(repo, "a1", "u1", "r");
    expect(await svc.can("u1", ORG, { permission: "identity:read" })).toBe(false);
  });

  it("denies an unknown subject", async () => {
    const { svc } = build();
    expect(await svc.can("ghost", ORG, { permission: "identity:read" })).toBe(false);
  });

  it("batch decisions preserve request order (20 mixed)", async () => {
    const { repo, svc } = build();
    await seedRole(repo, "r", ["identity:read"]);
    await seedUser(repo, "u1");
    await assign(repo, "a1", "u1", "r");
    const checks: identity.AuthzQuery[] = Array.from({ length: 20 }, (_, i) => ({ permission: i % 2 === 0 ? "identity:read" : "identity:admin" }));
    const res = await svc.authzCheck({ subjectUserId: "u1", orgId: ORG, checks });
    expect(res.decisions).toHaveLength(20);
    res.decisions.forEach((d, i) => expect(d.allowed).toBe(i % 2 === 0));
    expect(res.decisions[0]!.ttlSeconds).toBe(60);
  });

  it("rejects a batch over 20 with VALIDATION_FAILED", async () => {
    const { svc } = build();
    const checks: identity.AuthzQuery[] = Array.from({ length: 21 }, () => ({ permission: "identity:read" }));
    try {
      await svc.authzCheck({ subjectUserId: "u1", orgId: ORG, checks });
      expect.unreachable();
    } catch (e) {
      expect(isDubError(e) && e.code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("POST /authz/check endpoint", () => {
  it("requires x-dub-internal (403 without it)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/authz/check", jsonBody({ headers: { "x-dub-request-id": "r" } }, "POST", { subjectUserId: h.memberId, orgId: "org_devhub", checks: [{ permission: "identity:read" }] }));
    expect(res.status).toBe(403);
  });

  it("returns index-matched decisions for a valid internal call", async () => {
    const h = await makeHarness();
    const res = await h.app.request(
      "/authz/check",
      jsonBody(internal(), "POST", { subjectUserId: h.memberId, orgId: "org_devhub", checks: [{ permission: "identity:read" }, { permission: "identity:admin" }] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as identity.AuthzCheckResponse;
    expect(body.decisions.map((d) => d.allowed)).toEqual([true, false]);
  });
});
