// POST /internal/users/avatars — batch email → avatarUrl for mail-gateway's sender icons.
import { describe, it, expect } from "vitest";
import { makeHarness, internal, jsonBody } from "./harness";

type AvatarsBody = { avatars: Record<string, string> };

describe("POST /internal/users/avatars", () => {
  it("returns avatars only for active roster users that set one (case-insensitive)", async () => {
    const h = await makeHarness();
    await h.repo.updateUser(h.adminId, { avatarUrl: "https://img.example/admin.png" }, new Date().toISOString());
    const res = await h.app.request(
      "/internal/users/avatars",
      jsonBody(internal(), "POST", { emails: ["ADMIN@devhub.jp", "nobody@devhub.jp", "admin@devhub.jp"] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as AvatarsBody).toEqual({ avatars: { "admin@devhub.jp": "https://img.example/admin.png" } });
  });

  it("omits users without an avatar and non-active users", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/internal/users/avatars", jsonBody(internal(), "POST", { emails: ["admin@devhub.jp"] }));
    expect(((await res.json()) as AvatarsBody).avatars).toEqual({});

    await h.repo.updateUser(h.adminId, { avatarUrl: "https://img.example/admin.png", status: "disabled" }, new Date().toISOString());
    const res2 = await h.app.request("/internal/users/avatars", jsonBody(internal(), "POST", { emails: ["admin@devhub.jp"] }));
    expect(((await res2.json()) as AvatarsBody).avatars).toEqual({});
  });

  it("requires the internal marker (403 without x-dub-internal)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/internal/users/avatars", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dub-request-id": "req_test" },
      body: JSON.stringify({ emails: ["admin@devhub.jp"] }),
    });
    expect(res.status).toBe(403);
  });

  it("400s on a missing or oversized emails list", async () => {
    const h = await makeHarness();
    expect((await h.app.request("/internal/users/avatars", jsonBody(internal(), "POST", {}))).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@devhub.jp`);
    expect((await h.app.request("/internal/users/avatars", jsonBody(internal(), "POST", { emails: many }))).status).toBe(400);
  });
});
