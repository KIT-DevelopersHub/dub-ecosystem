import { describe, it, expect } from "vitest";
import { identity } from "@dub/types";
import {
  groupByDomain,
  togglePermission,
  toggleDomain,
  domainSelectionState,
  isDangerous,
  buildRoleUpdate,
  lockedKeysForRole,
} from "../src/lib/permissionMatrix";

const catalog = [...identity.PERMISSION_CATALOG];

describe("permissionMatrix — grouping", () => {
  it("groups catalog entries by domain preserving first-seen order", () => {
    const groups = groupByDomain(catalog);
    expect(groups[0]!.domain).toBe("identity");
    // every entry accounted for
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    expect(total).toBe(catalog.length);
    // identity group contains both identity keys
    const idKeys = groups.find((g) => g.domain === "identity")!.entries.map((e) => e.key);
    expect(idKeys).toEqual(["identity:read", "identity:admin"]);
  });
});

describe("permissionMatrix — selection", () => {
  it("toggles a single key on and off, returning a sorted set", () => {
    const added = togglePermission([], "event:read");
    expect(added).toEqual(["event:read"]);
    expect(togglePermission(added, "event:read")).toEqual([]);
  });

  it("selects/deselects a whole domain", () => {
    const eventEntries = catalog.filter((e) => e.domain === "event");
    const all = toggleDomain([], eventEntries, true);
    expect(all).toEqual(["event:admin", "event:read", "event:write"]);
    expect(toggleDomain(all, eventEntries, false)).toEqual([]);
  });

  it("reports domain header state (all / some / none)", () => {
    const eventEntries = catalog.filter((e) => e.domain === "event");
    expect(domainSelectionState([], eventEntries)).toEqual({ all: false, some: false });
    expect(domainSelectionState(["event:read"], eventEntries)).toEqual({ all: false, some: true });
    const all = eventEntries.map((e) => e.key as identity.PermissionKey);
    expect(domainSelectionState(all, eventEntries)).toEqual({ all: true, some: true });
  });

  it("keeps locked keys when deselecting a whole domain (self-lockout guard)", () => {
    const idEntries = catalog.filter((e) => e.domain === "identity");
    const all = idEntries.map((e) => e.key as identity.PermissionKey); // identity:read + identity:admin
    // Without a lock, deselecting clears the domain.
    expect(toggleDomain(all, idEntries, false)).toEqual([]);
    // With identity:admin locked, it survives a domain-off toggle.
    expect(toggleDomain(all, idEntries, false, ["identity:admin"])).toEqual(["identity:admin"]);
  });

  it("flags dangerous permissions from the catalog", () => {
    expect(isDangerous(catalog, "identity:admin")).toBe(true);
    expect(isDangerous(catalog, "identity:read")).toBe(false);
  });

  it("locks identity:admin + the 管理 app access keys only on the built-in admin role", () => {
    expect(lockedKeysForRole({ name: "admin", isSystem: true })).toEqual([
      "identity:admin",
      "app:admin:view",
      "app:admin:edit",
    ]);
    expect(lockedKeysForRole({ name: "member", isSystem: true })).toEqual([]);
    expect(lockedKeysForRole({ name: "admin", isSystem: false })).toEqual([]);
  });
});

describe("permissionMatrix — buildRoleUpdate (diff only)", () => {
  const original = { name: "organizer", permissions: ["event:read", "event:write"] as identity.PermissionKey[] };

  it("returns null when nothing changed (set equality, order-insensitive)", () => {
    expect(buildRoleUpdate(original, { name: "organizer", permissions: ["event:write", "event:read"] })).toBeNull();
  });

  it("carries only the changed permissions field", () => {
    const patch = buildRoleUpdate(original, { name: "organizer", permissions: ["event:read"] });
    expect(patch).toEqual({ permissions: ["event:read"] });
    expect(patch).not.toHaveProperty("name");
  });

  it("carries only the changed name field", () => {
    const patch = buildRoleUpdate(original, { name: "lead", permissions: ["event:read", "event:write"] });
    expect(patch).toEqual({ name: "lead" });
    expect(patch).not.toHaveProperty("permissions");
  });

  it("carries both when both change", () => {
    const patch = buildRoleUpdate(original, { name: "lead", permissions: ["event:admin"] });
    expect(patch).toEqual({ name: "lead", permissions: ["event:admin"] });
  });
});
