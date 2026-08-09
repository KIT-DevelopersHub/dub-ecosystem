import { describe, it, expect } from "vitest";
import { buildListUsersParams, toListUsersQuery, DEFAULT_USER_FILTERS } from "../src/lib/listUsersQuery";

describe("buildListUsersParams", () => {
  it("omits empty / all / null filters", () => {
    expect(buildListUsersParams(DEFAULT_USER_FILTERS)).toEqual({});
  });

  it("trims and includes free-text search as q", () => {
    expect(buildListUsersParams({ ...DEFAULT_USER_FILTERS, search: "  alice " })).toEqual({ q: "alice" });
  });

  it("includes status when not 'all' and roleKey when set", () => {
    const params = buildListUsersParams({ ...DEFAULT_USER_FILTERS, status: "invited", roleKey: "identity:admin" });
    expect(params).toEqual({ status: "invited", roleKey: "identity:admin" });
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
