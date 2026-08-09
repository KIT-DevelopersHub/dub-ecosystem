import { describe, it, expect } from "vitest";
import { buildAssignRequest, eventScopeAvailable, DEFAULT_SCOPE } from "../src/lib/scope";

describe("buildAssignRequest", () => {
  it("org-wide OMITS resourceType/resourceId (not null)", () => {
    const req = buildAssignRequest("role_1", DEFAULT_SCOPE);
    expect(req).toEqual({ roleId: "role_1" });
    expect(Object.prototype.hasOwnProperty.call(req, "resourceType")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(req, "resourceId")).toBe(false);
  });

  it("event scope includes both fields", () => {
    expect(buildAssignRequest("role_1", { kind: "event", eventId: "evt_9" })).toEqual({
      roleId: "role_1",
      resourceType: "event",
      resourceId: "evt_9",
    });
  });

  it("event scope without an eventId falls back to org-wide (fields omitted)", () => {
    expect(buildAssignRequest("role_1", { kind: "event", eventId: null })).toEqual({ roleId: "role_1" });
  });
});

describe("eventScopeAvailable — degrade when event:read missing", () => {
  it("requires event:read", () => {
    expect(eventScopeAvailable(["event:read"])).toBe(true);
    expect(eventScopeAvailable(["identity:admin"])).toBe(false);
    expect(eventScopeAvailable(null)).toBe(false);
  });
});
