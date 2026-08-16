import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeHarness, asUser } from "./harness";

describe("app-level auth & routing", () => {
  it("health is public", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true, service: "identity-roster" });
  });

  it("external routes require x-dub-user-id (401)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/users");
    expect(res.status).toBe(401);
  });

  it("member is forbidden from admin operations (403)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/roles", { ...asUser(h.memberId), method: "POST", headers: { ...asUser(h.memberId).headers, "content-type": "application/json" }, body: JSON.stringify({ name: "x", permissions: [] }) });
    expect(res.status).toBe(403);
  });

  it("member can read the roster (identity:read)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/users", asUser(h.memberId));
    expect(res.status).toBe(200);
  });

  it("exposes the frozen 34-key permission catalog", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/permissions/catalog", asUser(h.memberId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as identity.PermissionCatalogEntry[];
    expect(body).toHaveLength(34);
    // <domain>:<action>[:self] — action may contain an underscore (mail:read_all).
    expect(body.every((e) => /^[a-z]+:[a-z_]+(:self)?$/.test(e.key))).toBe(true);
  });

  it("error responses use the wire ErrorResponse shape", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/users");
    const body = (await res.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("AUTH_INVALID_TOKEN");
    expect(typeof body.error.retryable).toBe("boolean");
  });
});
