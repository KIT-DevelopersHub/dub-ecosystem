import { describe, it, expect } from "vitest";
import { parseRosterView, serializeRosterView } from "../src/lib/urlFilters";

describe("urlFilters", () => {
  it("parses defaults from an empty query", () => {
    const v = parseRosterView("");
    expect(v.filters).toEqual({ search: "", status: "all", roleKey: null });
    expect(v.sort).toBeUndefined();
  });

  it("parses search + status + sort", () => {
    const v = parseRosterView("?q=alice&status=active&sort=name&dir=desc");
    expect(v.filters).toEqual({ search: "alice", status: "active", roleKey: null });
    expect(v.sort).toEqual({ key: "name", direction: "desc" });
  });

  it("round-trips the role filter", () => {
    expect(parseRosterView("?role=role_lead").filters.roleKey).toBe("role_lead");
    expect(serializeRosterView({ filters: { search: "", status: "all", roleKey: "role_lead" }, sort: undefined })).toBe("role=role_lead");
    expect(serializeRosterView({ filters: { search: "", status: "all", roleKey: null }, sort: undefined }, "role=role_lead")).toBe("");
  });

  it("drops an unknown status / unknown sort key", () => {
    const v = parseRosterView("?status=bogus&sort=roles");
    expect(v.filters.status).toBe("all");
    expect(v.sort).toBeUndefined();
  });

  it("defaults sort direction to asc when dir is missing/invalid", () => {
    expect(parseRosterView("?sort=email").sort).toEqual({ key: "email", direction: "asc" });
    expect(parseRosterView("?sort=email&dir=nope").sort).toEqual({ key: "email", direction: "asc" });
  });

  it("serializes only non-default values", () => {
    expect(serializeRosterView({ filters: { search: "", status: "all", roleKey: null }, sort: undefined })).toBe("");
    expect(serializeRosterView({ filters: { search: "bob", status: "disabled", roleKey: null }, sort: { key: "status", direction: "asc" } }))
      .toBe("q=bob&status=disabled&sort=status&dir=asc");
  });

  it("round-trips through serialize -> parse", () => {
    const state = { filters: { search: "x y", status: "invited" as const, roleKey: "r1" }, sort: { key: "email", direction: "desc" as const } };
    expect(parseRosterView(`?${serializeRosterView(state)}`)).toEqual(state);
  });

  it("preserves unrelated params already in the URL", () => {
    const out = serializeRosterView({ filters: { search: "a", status: "all", roleKey: null }, sort: undefined }, "keep=1");
    expect(out).toContain("keep=1");
    expect(out).toContain("q=a");
  });
});
