import { describe, it, expect } from "vitest";
import { canWith, canAll } from "../src/lib/permissions";

describe("canWith — fail-closed", () => {
  it("denies when permissions are null (loading)", () => {
    expect(canWith(null, "identity:read")).toBe(false);
    expect(canWith(undefined, "identity:read")).toBe(false);
  });
  it("allows only listed permissions", () => {
    expect(canWith(["identity:read"], "identity:read")).toBe(true);
    expect(canWith(["identity:read"], "identity:admin")).toBe(false);
  });
});

describe("canAll", () => {
  it("fails closed while loading even for empty requirement", () => {
    expect(canAll(null, [])).toBe(false);
  });
  it("empty requirement means any authenticated user once loaded", () => {
    expect(canAll([], [])).toBe(true);
  });
  it("requires every permission to hold", () => {
    expect(canAll(["identity:read", "audit:read"], ["identity:read", "audit:read"])).toBe(true);
    expect(canAll(["identity:read"], ["identity:read", "audit:read"])).toBe(false);
  });
});
