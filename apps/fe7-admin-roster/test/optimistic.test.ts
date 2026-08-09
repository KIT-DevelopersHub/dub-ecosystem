import { describe, it, expect } from "vitest";
import { isOptimistic, applyUserPatch, applyRoleGrant, makePendingAssignment } from "../src/lib/optimistic";
import type { RoleAssignment } from "../src/contracts/pending";

describe("optimistic policy", () => {
  it("marks profile edit and role grant optimistic; destructive ops non-optimistic", () => {
    expect(isOptimistic("user.patch")).toBe(true);
    expect(isOptimistic("role.grant")).toBe(true);
    expect(isOptimistic("role.revoke")).toBe(false);
    expect(isOptimistic("role.save")).toBe(false);
    expect(isOptimistic("user.status")).toBe(false);
    expect(isOptimistic("role.delete")).toBe(false);
  });
});

describe("cache transforms", () => {
  it("applyUserPatch merges without mutating the source", () => {
    const user = { id: "u1", displayName: "A" };
    const next = applyUserPatch(user, { displayName: "B" });
    expect(next).toEqual({ id: "u1", displayName: "B" });
    expect(user.displayName).toBe("A");
  });

  it("applyRoleGrant appends the pending assignment", () => {
    const existing: RoleAssignment[] = [];
    const pending = makePendingAssignment({ userId: "u1", roleId: "r1", roleName: "member", grantedBy: "admin", now: "2026-08-09T00:00:00Z" });
    const next = applyRoleGrant(existing, pending);
    expect(next).toHaveLength(1);
    expect(next[0]!.roleId).toBe("r1");
    expect(next[0]!.resourceType).toBeNull(); // org-wide default
  });

  it("makePendingAssignment carries event scope when provided", () => {
    const pending = makePendingAssignment({ userId: "u1", roleId: "r1", roleName: "member", resourceType: "event", resourceId: "e1", grantedBy: "admin", now: "t" });
    expect(pending.resourceType).toBe("event");
    expect(pending.resourceId).toBe("e1");
  });
});
