import { describe, it, expect } from "vitest";
import { buildListUsersParams, toListUsersQuery, DEFAULT_USER_FILTERS } from "../src/lib/listUsersQuery";

describe("buildListUsersParams", () => {
  // The default roster request carries a full-page limit (200) so a 50人規模の org loads
  // in one page and the DataTable 仮想スクロール (>= threshold 50) engages — see
  // DEFAULT_USER_FILTERS.limit. Empty text / "all" status / null roleKey stay omitted.
  it("omits empty / all / null filters (default carries the full-page limit)", () => {
    expect(buildListUsersParams(DEFAULT_USER_FILTERS)).toEqual({ limit: 200 });
  });

  it("trims and includes free-text search as q", () => {
    expect(buildListUsersParams({ ...DEFAULT_USER_FILTERS, search: "  alice " })).toEqual({ q: "alice", limit: 200 });
  });

  it("includes status when not 'all' and roleKey when set", () => {
    const params = buildListUsersParams({ ...DEFAULT_USER_FILTERS, status: "invited", roleKey: "identity:admin" });
    expect(params).toEqual({ status: "invited", roleKey: "identity:admin", limit: 200 });
  });

  it("passes cursor and limit through", () => {
    const params = buildListUsersParams({ ...DEFAULT_USER_FILTERS, cursor: "c1", limit: 25 });
    expect(params).toEqual({ cursor: "c1", limit: 25 });
  });
});

describe("toListUsersQuery — frozen-contract subset", () => {
  it("only emits cursor/limit typed fields", () => {
    expect(toListUsersQuery({ ...DEFAULT_USER_FILTERS, search: "x", cursor: "c", limit: 10 })).toEqual({ cursor: "c", limit: 10 });
  });
});
