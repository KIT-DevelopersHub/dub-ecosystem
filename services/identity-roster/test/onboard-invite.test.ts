// POST /internal/users/onboard + /internal/users/:id/discard-onboard — 参加届からのアカウント
// 発行 (api-gateway onboard-account)。ロールは一般メンバー固定・取り消しは手付かずの招待だけ。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeHarness, asUser, internal, jsonBody, ORG_ID, type Harness } from "./harness";

function asInternal(h: Harness, method: string, body?: unknown): RequestInit {
  const init = body === undefined ? { ...internal(), method } : jsonBody(internal(), method, body);
  init.headers = { ...(init.headers as Record<string, string>), "x-dub-user-id": h.memberId };
  return init;
}

async function onboard(h: Harness, body: Record<string, unknown>) {
  const res = await h.app.request("/internal/users/onboard", asInternal(h, "POST", body));
  return { status: res.status, json: (await res.json()) as { user: identity.IdentityUser; error?: { code: string } } };
}

describe("onboard invite (POST /internal/users/onboard)", () => {
  it("creates an invited user holding only the member system role, ignoring roleIds in the body", async () => {
    const h = await makeHarness();
    const res = await onboard(h, { email: "new@developershub.jp", displayName: "新人", furigana: "シンジン", roleIds: [h.adminRoleId] });
    expect(res.status).toBe(201);
    const id = res.json.user.id;
    const row = (await h.repo.getUser(id))!;
    expect(row.status).toBe("invited");
    expect(row.displayName).toBe("新人");
    expect(row.furigana).toBe("シンジン");
    const roles = (await h.repo.listAssignmentsByUser(id, ORG_ID)).map((a) => a.roleId);
    expect(roles).toEqual([h.memberRoleId]);
  });

  it("refuses (409) an email that is already on the roster (existing accounts are never touched)", async () => {
    const h = await makeHarness();
    const res = await onboard(h, { email: "member@devhub.jp" });
    expect(res.status).toBe(409);
    expect(res.json.error?.code).toBe("CONFLICT");
  });

  it("is INTERNAL only: a signed-in caller without the marker is refused", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/internal/users/onboard", jsonBody(asUser(h.adminId), "POST", { email: "x@developershub.jp" }));
    expect(res.status).toBe(403);
  });
});

describe("discard onboard invite (POST /internal/users/:id/discard-onboard)", () => {
  it("deletes an untouched onboarding invite and its role", async () => {
    const h = await makeHarness();
    const id = (await onboard(h, { email: "new@developershub.jp" })).json.user.id;
    const res = await h.app.request(`/internal/users/${id}/discard-onboard`, asInternal(h, "POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discarded: true });
    expect(await h.repo.getUser(id)).toBeNull();
    expect(await h.repo.listAssignmentsByUser(id, ORG_ID)).toEqual([]);
    // 再実行しても安全 (no-op)
    const again = await h.app.request(`/internal/users/${id}/discard-onboard`, asInternal(h, "POST"));
    expect(await again.json()).toEqual({ discarded: false });
  });

  it("never deletes an active account", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/internal/users/${h.memberId}/discard-onboard`, asInternal(h, "POST"));
    expect(res.status).toBe(409);
    expect(await h.repo.getUser(h.memberId)).not.toBeNull();
  });

  it("never deletes an invite that holds any other role", async () => {
    const h = await makeHarness();
    const id = (await onboard(h, { email: "new@developershub.jp" })).json.user.id;
    await h.repo.createAssignment({ id: "ra_extra", userId: id, roleId: h.adminRoleId, orgId: ORG_ID, resourceType: null, resourceId: null, grantedBy: h.adminId, grantedAt: "2026-08-09T00:00:00.000Z" });
    const res = await h.app.request(`/internal/users/${id}/discard-onboard`, asInternal(h, "POST"));
    expect(res.status).toBe(409);
    expect(await h.repo.getUser(id)).not.toBeNull();
  });

  it("never deletes an older invite (only the one this onboarding call just made)", async () => {
    const h = await makeHarness();
    await h.repo.createUser({ id: "user_old_inv", orgId: ORG_ID, email: "old@developershub.jp", displayName: "Old", furigana: null, githubLogin: null, avatarUrl: null, status: "invited", source: "manual", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" });
    const res = await h.app.request(`/internal/users/user_old_inv/discard-onboard`, asInternal(h, "POST"));
    expect(res.status).toBe(409);
    expect(await h.repo.getUser("user_old_inv")).not.toBeNull();
  });
});
