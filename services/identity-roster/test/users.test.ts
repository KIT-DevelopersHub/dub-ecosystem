import { describe, it, expect } from "vitest";
import type { common, identity } from "@dub/types";
import { makeHarness, asUser, jsonBody, ORG_ID } from "./harness";

describe("users listing & detail", () => {
  it("lists users (paginated shape)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/users", asUser(h.adminId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as common.Paginated<identity.IdentityUser>;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("supports an ids batch lookup", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/users?ids=${h.memberId}`, asUser(h.adminId));
    const body = (await res.json()) as common.Paginated<identity.IdentityUser>;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(h.memberId);
  });

  it("rejects an ids batch over 50 with VALIDATION_FAILED", async () => {
    const h = await makeHarness();
    const ids = Array.from({ length: 51 }, (_, i) => `user_${i}`).join(",");
    const res = await h.app.request(`/identity/users?ids=${ids}`, asUser(h.adminId));
    expect(res.status).toBe(400);
  });

  it("allows a user to read their own detail without identity:read", async () => {
    const h = await makeHarness();
    // strip member's permissions by making them a bare user with no roles
    await h.repo.createUser({ id: "user_bare", orgId: ORG_ID, email: "bare@devhub.jp", displayName: "Bare", githubLogin: null, avatarUrl: null, status: "active", createdAt: "t", updatedAt: "t" });
    const self = await h.app.request("/identity/users/user_bare", asUser("user_bare"));
    expect(self.status).toBe(200);
    // but cannot read someone else without identity:read
    const other = await h.app.request(`/identity/users/${h.adminId}`, asUser("user_bare"));
    expect(other.status).toBe(403);
  });
});

describe("update user (PATCH /identity/users/:id)", () => {
  it("updates display name and github login", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/users/${h.memberId}`, jsonBody(asUser(h.adminId), "PATCH", { displayName: "Renamed", githubLogin: "octocat" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as identity.IdentityUser;
    expect(body.displayName).toBe("Renamed");
    expect(body.githubLogin).toBe("octocat");
  });

  it("disabling a user synchronously revokes their sessions", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/users/${h.memberId}`, jsonBody(asUser(h.adminId), "PATCH", { status: "disabled" }));
    expect(res.status).toBe(200);
    expect(h.revoker.calls).toContain(h.memberId);
  });

  it("fail-close: revoke failure aborts the disable (502, status unchanged)", async () => {
    const h = await makeHarness();
    h.revoker.fail = true;
    const res = await h.app.request(`/identity/users/${h.memberId}`, jsonBody(asUser(h.adminId), "PATCH", { status: "disabled" }));
    expect(res.status).toBe(502);
    expect((await h.repo.getUser(h.memberId))!.status).toBe("active");
  });

  it("guards against disabling the last identity:admin holder (409)", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/users/${h.adminId}`, jsonBody(asUser(h.adminId), "PATCH", { status: "disabled" }));
    expect(res.status).toBe(409);
    expect(h.revoker.calls).not.toContain(h.adminId); // never even attempted the revoke
  });

  it("returns 404 for an unknown user", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/users/ghost", jsonBody(asUser(h.adminId), "PATCH", { displayName: "x" }));
    expect(res.status).toBe(404);
  });
});
