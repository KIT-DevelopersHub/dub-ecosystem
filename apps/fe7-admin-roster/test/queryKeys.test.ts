import { describe, it, expect } from "vitest";
import { queryKeys, ADMIN_QK } from "../src/lib/queryKeys";
import { DEFAULT_USER_FILTERS } from "../src/lib/listUsersQuery";
import { DEFAULT_AUDIT_FILTERS } from "../src/lib/auditQuery";

describe("queryKeys — must start with the FeatureModule id 'admin' (frozen 1-1-4)", () => {
  it("every key begins with 'admin'", () => {
    const keys = [
      queryKeys.users(DEFAULT_USER_FILTERS),
      queryKeys.user("u1"),
      queryKeys.userRoles("u1"),
      queryKeys.roles(),
      queryKeys.role("r1"),
      queryKeys.permissionCatalog(),
      queryKeys.audit(DEFAULT_AUDIT_FILTERS),
      queryKeys.userSummaries(["u2", "u1"]),
      queryKeys.events(),
    ];
    for (const k of keys) expect(k[0]).toBe(ADMIN_QK);
  });

  it("userSummaries sorts ids for stable cache identity", () => {
    expect(queryKeys.userSummaries(["u2", "u1"])).toEqual([ADMIN_QK, "users", "summaries", ["u1", "u2"]]);
  });
});
