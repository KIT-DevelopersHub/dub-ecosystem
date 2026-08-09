import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeHarness, asUser, internal, jsonBody, ORG_ID } from "./harness";
import type { InviteUserResponse, ProvisionUserResponse } from "../src/dto";

describe("invite (POST /identity/users/invite)", () => {
  it("creates an invited row with pre-assigned org-wide roles", async () => {
    const h = await makeHarness();
    const res = await h.app.request(
      "/identity/users/invite",
      jsonBody(asUser(h.adminId), "POST", { email: "new@devhub.jp", displayName: "New", roleIds: [h.memberRoleId] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteUserResponse;
    expect(body.user.status).toBe("invited");
    expect(body.user.roleIds).toEqual([h.memberRoleId]);
    expect(h.audit.published.some((a) => a.action === "identity.user.invited")).toBe(true);
  });

  it("rejects a re-invite of an existing email with CONFLICT", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/users/invite", jsonBody(asUser(h.adminId), "POST", { email: "member@devhub.jp" }));
    expect(res.status).toBe(409);
  });

  it("requires identity:admin (member -> 403)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/users/invite", jsonBody(asUser(h.memberId), "POST", { email: "x@devhub.jp" }));
    expect(res.status).toBe(403);
  });
});

describe("provision (POST /users/provision, internal)", () => {
  it("activates an invited user and reports provisioned", async () => {
    const h = await makeHarness();
    await h.app.request("/identity/users/invite", jsonBody(asUser(h.adminId), "POST", { email: "inv@devhub.jp", displayName: "Inv" }));
    const res = await h.app.request("/users/provision", jsonBody(internal(), "POST", { email: "inv@devhub.jp", displayName: "Inv Real" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProvisionUserResponse;
    expect(body.status).toBe("provisioned");
    expect(body.user?.status).toBe("active");
    // provision uses the synchronous write-ahead audit channel
    expect(h.audit.syncCalls.some((a) => a.action === "identity.user.provisioned")).toBe(true);
  });

  it("is idempotent for an already-active user (existing)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/users/provision", jsonBody(internal(), "POST", { email: "member@devhub.jp", displayName: "Member" }));
    const body = (await res.json()) as ProvisionUserResponse;
    expect(body.status).toBe("existing");
  });

  it("rejects a non-invited email without creating a row", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/users/provision", jsonBody(internal(), "POST", { email: "stranger@devhub.jp", displayName: "S" }));
    const body = (await res.json()) as ProvisionUserResponse;
    expect(body.status).toBe("rejected");
    expect(body.user).toBeNull();
    expect(await h.repo.getUserByEmail(ORG_ID, "stranger@devhub.jp")).toBeNull();
  });

  it("fail-close: sync audit failure aborts activation with 502", async () => {
    const h = await makeHarness();
    await h.app.request("/identity/users/invite", jsonBody(asUser(h.adminId), "POST", { email: "inv2@devhub.jp", displayName: "Inv2" }));
    h.audit.failSync = true;
    const res = await h.app.request("/users/provision", jsonBody(internal(), "POST", { email: "inv2@devhub.jp", displayName: "Inv2" }));
    expect(res.status).toBe(502);
    const still = (await h.repo.getUserByEmail(ORG_ID, "inv2@devhub.jp"))!;
    expect(still.status).toBe("invited"); // unchanged
  });

  it("requires x-dub-internal (403)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/users/provision", jsonBody({ headers: { "x-dub-request-id": "r" } }, "POST", { email: "a@b.jp", displayName: "A" }));
    expect(res.status).toBe(403);
  });
});

describe("effective permissions (internal /me aggregation)", () => {
  it("returns the member's org-wide permissions", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/internal/users/${h.memberId}/permissions`, internal());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: identity.PermissionKey[] };
    expect(body.permissions).toContain("identity:read");
    expect(body.permissions).not.toContain("identity:admin");
  });
});
