import { describe, it, expect } from "vitest";
import { sortUsers, isSortableUserKey } from "../src/lib/sortUsers";
import type { RosterUser } from "../src/contracts/pending";

function u(id: string, displayName: string, email: string, status: RosterUser["status"], source?: RosterUser["source"]): RosterUser {
  return {
    id, orgId: "org", displayName, email, githubLogin: null, avatarUrl: null,
    status, roleIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    ...(source ? { source } : {}),
  };
}

const rows: RosterUser[] = [
  u("1", "Carol", "carol@x.jp", "invited"),
  u("2", "Alice", "alice@x.jp", "active", "email-routing"),
  u("3", "Bob", "bob@x.jp", "disabled"),
];

describe("sortUsers", () => {
  it("returns a shallow copy (not the same array) when unsorted", () => {
    const out = sortUsers(rows, undefined);
    expect(out).not.toBe(rows);
    expect(out.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("sorts by name ascending / descending", () => {
    expect(sortUsers(rows, { key: "name", direction: "asc" }).map((r) => r.displayName)).toEqual(["Alice", "Bob", "Carol"]);
    expect(sortUsers(rows, { key: "name", direction: "desc" }).map((r) => r.displayName)).toEqual(["Carol", "Bob", "Alice"]);
  });

  it("sorts by email", () => {
    expect(sortUsers(rows, { key: "email", direction: "asc" }).map((r) => r.email)).toEqual(["alice@x.jp", "bob@x.jp", "carol@x.jp"]);
  });

  it("sorts by status lifecycle order (active < invited < disabled)", () => {
    expect(sortUsers(rows, { key: "status", direction: "asc" }).map((r) => r.status)).toEqual(["active", "invited", "disabled"]);
  });

  it("sorts email-routing rows first by source asc", () => {
    expect(sortUsers(rows, { key: "source", direction: "asc" })[0]!.source).toBe("email-routing");
  });

  it("is stable for equal keys", () => {
    const dup = [u("a", "Same", "a@x.jp", "active"), u("b", "Same", "b@x.jp", "active")];
    expect(sortUsers(dup, { key: "name", direction: "asc" }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("ignores unknown sort keys", () => {
    expect(sortUsers(rows, { key: "roles", direction: "asc" }).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(isSortableUserKey("roles")).toBe(false);
    expect(isSortableUserKey("name")).toBe(true);
  });
});
