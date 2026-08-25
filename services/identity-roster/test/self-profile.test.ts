// Self profile edit (アカウント設定 → 表示名/アバター): the gateway's POST /api/v1/me/profile
// forwards here as an internal s2s call scoped to the caller's own userId. updateOwnProfile
// only touches display_name / avatar_url — it can never escalate roles or disable accounts.
import { describe, it, expect } from "vitest";
import { makeHarness, internal, jsonBody } from "./harness";

const profileUrl = (id: string): string => `http://svc/internal/users/${id}/profile`;

describe("identity-roster self profile (POST /internal/users/:id/profile)", () => {
  it("updates the caller's own display name + avatar and persists them", async () => {
    const h = await makeHarness();
    const res = await h.app.request(
      profileUrl(h.memberId),
      jsonBody(internal(), "POST", { displayName: "新しい名前", avatarUrl: "data:image/png;base64,AAAA" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; avatarUrl: string | null };
    expect(body.displayName).toBe("新しい名前");
    expect(body.avatarUrl).toBe("data:image/png;base64,AAAA");

    const stored = (await h.repo.getUser(h.memberId))!;
    expect(stored.displayName).toBe("新しい名前");
    expect(stored.avatarUrl).toBe("data:image/png;base64,AAAA");
    expect(h.audit.published.some((r) => r.action === "identity.user.profile_updated")).toBe(true);
  });

  it("avatarUrl: null clears the avatar (back to initials)", async () => {
    const h = await makeHarness();
    await h.repo.updateUser(h.memberId, { avatarUrl: "data:image/png;base64,ZZZZ" }, "2026-08-09T00:00:00.000Z");
    const res = await h.app.request(profileUrl(h.memberId), jsonBody(internal(), "POST", { avatarUrl: null }));
    expect(res.status).toBe(200);
    expect((await h.repo.getUser(h.memberId))!.avatarUrl).toBeNull();
  });

  it("rejects a blank display name", async () => {
    const h = await makeHarness();
    const res = await h.app.request(profileUrl(h.memberId), jsonBody(internal(), "POST", { displayName: "   " }));
    expect(res.status).toBe(400);
  });

  it("does not touch status or roles (leaves the account active)", async () => {
    const h = await makeHarness();
    await h.app.request(profileUrl(h.memberId), jsonBody(internal(), "POST", { displayName: "X" }));
    expect((await h.repo.getUser(h.memberId))!.status).toBe("active");
    expect(h.revoker.calls).toHaveLength(0);
  });
});
