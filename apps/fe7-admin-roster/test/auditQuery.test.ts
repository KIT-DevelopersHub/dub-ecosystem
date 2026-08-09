import { describe, it, expect } from "vitest";
import { buildAuditQuery, isIdentityAuditAction, DEFAULT_AUDIT_FILTERS } from "../src/lib/auditQuery";

describe("buildAuditQuery — identity-scoped", () => {
  it("defaults to the identity.* prefix", () => {
    expect(buildAuditQuery(DEFAULT_AUDIT_FILTERS)).toEqual({ action: "identity." });
  });
  it("narrows to a specific action when set", () => {
    expect(buildAuditQuery({ ...DEFAULT_AUDIT_FILTERS, action: "identity.role.assigned" })).toMatchObject({
      action: "identity.role.assigned",
    });
  });
  it("passes actor/date/cursor filters through", () => {
    const q = buildAuditQuery({ actorId: "u1", action: null, since: "2026-08-01", until: "2026-08-09", cursor: "c", limit: 20 });
    expect(q).toEqual({ action: "identity.", actorId: "u1", since: "2026-08-01", until: "2026-08-09", cursor: "c", limit: 20 });
  });
});

describe("isIdentityAuditAction", () => {
  it("accepts identity.* only", () => {
    expect(isIdentityAuditAction("identity.role.assigned")).toBe(true);
    expect(isIdentityAuditAction("task.item.created")).toBe(false);
  });
});
