import { describe, it, expect } from "vitest";
import type { gateway } from "@dub/types";
import { derivePermissions, DENY_ALL } from "../src/lib/permissions";

function me(perms: gateway.MeResponse["permissions"]): gateway.MeResponse {
  return {
    user: { id: "u", displayName: "n", avatarUrl: null },
    orgId: "org_devhub",
    permissions: perms,
    sessionExpiresAt: 0,
  };
}

describe("derivePermissions (test observation #8, fail-closed)", () => {
  it("denies everything while loading", () => {
    expect(derivePermissions(me(["event:admin"]), true)).toEqual(DENY_ALL);
  });

  it("denies everything when me is null", () => {
    expect(derivePermissions(null, false)).toEqual(DENY_ALL);
  });

  it("read-only user gets read only", () => {
    expect(derivePermissions(me(["event:read"]), false)).toEqual({ read: true, write: false, admin: false });
  });

  it("admin implies its own key only (no wildcard inheritance)", () => {
    expect(derivePermissions(me(["event:admin"]), false)).toEqual({ read: false, write: false, admin: true });
    expect(derivePermissions(me(["event:read", "event:write", "event:admin"]), false)).toEqual({
      read: true,
      write: true,
      admin: true,
    });
  });
});
