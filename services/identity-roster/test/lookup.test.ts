// POST /internal/users/lookup — read-only email→roster-user resolution used by
// auth-service's login allowlist. Internal-only; no provision side effects.
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeHarness, internal, jsonBody } from "./harness";

describe("POST /internal/users/lookup", () => {
  it("returns the canonical user for an on-roster email", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/internal/users/lookup", jsonBody(internal(), "POST", { email: "admin@devhub.jp" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: identity.IdentityUser | null };
    expect(body.user).toBeTruthy();
    expect(body.user!.email).toBe("admin@devhub.jp");
    expect(body.user!.status).toBe("active");
    expect(body.user!.id).toBe(h.adminId);
  });

  it("is case-insensitive on the email", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/internal/users/lookup", jsonBody(internal(), "POST", { email: "ADMIN@DEVHUB.JP" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: identity.IdentityUser | null }).user?.id).toBe(h.adminId);
  });

  it("returns { user: null } for an email not on the roster (no error, no side effects)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/internal/users/lookup", jsonBody(internal(), "POST", { email: "nobody@devhub.jp" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { user: identity.IdentityUser | null }).toEqual({ user: null });
  });

  it("requires the internal marker (403 without x-dub-internal)", async () => {
    const h = await makeHarness();
    const res = await h.app.request(
      "/internal/users/lookup",
      { method: "POST", headers: { "content-type": "application/json", "x-dub-request-id": "req_test" }, body: JSON.stringify({ email: "admin@devhub.jp" }) },
    );
    expect(res.status).toBe(403);
  });

  it("400s when email is missing", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/internal/users/lookup", jsonBody(internal(), "POST", {}));
    expect(res.status).toBe(400);
  });
});
