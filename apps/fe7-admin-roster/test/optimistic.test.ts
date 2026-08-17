import { describe, it, expect } from "vitest";
import { isOptimistic, applyUserPatch, applyRoleGrant, makePendingAssignment, addUserRoleId, removeUserRoleId } from "../src/lib/optimistic";
import type { RoleAssignment, RosterUser } from "../src/contracts/pending";
import type { common } from "@dub/types";

function page(users: Partial<RosterUser>[]): common.Paginated<RosterUser> {
  return { items: users as RosterUser[], nextCursor: null };
}

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

describe("roster-list roleIds transforms (inline role edit)", () => {
  it("addUserRoleId adds a role id to the target user only, idempotently", () => {
    const p = page([{ id: "u1", roleIds: [] }, { id: "u2", roleIds: ["r9"] }]);
    const once = addUserRoleId(p, "u1", "r1")!;
    expect(once.items[0]!.roleIds).toEqual(["r1"]);
    expect(once.items[1]!.roleIds).toEqual(["r9"]); // untouched
    // idempotent: adding the same id again is a no-op
    expect(addUserRoleId(once, "u1", "r1")!.items[0]!.roleIds).toEqual(["r1"]);
    // original not mutated
    expect(p.items[0]!.roleIds).toEqual([]);
  });

  it("removeUserRoleId removes a role id from the target user only", () => {
    const p = page([{ id: "u1", roleIds: ["r1", "r2"] }, { id: "u2", roleIds: ["r1"] }]);
    const next = removeUserRoleId(p, "u1", "r1")!;
    expect(next.items[0]!.roleIds).toEqual(["r2"]);
    expect(next.items[1]!.roleIds).toEqual(["r1"]); // untouched
    expect(p.items[0]!.roleIds).toEqual(["r1", "r2"]); // original not mutated
  });

  it("both helpers pass through undefined pages (no cache entry yet)", () => {
    expect(addUserRoleId(undefined, "u1", "r1")).toBeUndefined();
    expect(removeUserRoleId(undefined, "u1", "r1")).toBeUndefined();
  });
});
