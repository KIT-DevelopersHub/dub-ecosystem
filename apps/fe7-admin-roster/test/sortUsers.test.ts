import { describe, it, expect } from "vitest";
import { sortUsers, isSortableUserKey } from "../src/lib/sortUsers";
import type { RosterUser } from "../src/contracts/pending";

function u(id: string, displayName: string, email: string, status: RosterUser["status"], source?: RosterUser["source"], furigana?: string | null): RosterUser {
  return {
    id, orgId: "org", displayName, email, githubLogin: null, avatarUrl: null,
    status, roleIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    ...(source ? { source } : {}),
    ...(furigana !== undefined ? { furigana } : {}),
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

  it("sorts by furigana in 五十音 order (reading, not kanji glyph order)", () => {
    // 表示名(漢字)の字面順とは異なり、フリガナの読み順(あ→か→さ)で並ぶ。
    const kanji = [
      u("y", "山田", "y@x.jp", "active", undefined, "ヤマダ"),
      u("a", "安藤", "a@x.jp", "active", undefined, "アンドウ"),
      u("s", "佐藤", "s@x.jp", "active", undefined, "サトウ"),
    ];
    expect(sortUsers(kanji, { key: "furigana", direction: "asc" }).map((r) => r.id)).toEqual(["a", "s", "y"]);
    expect(isSortableUserKey("furigana")).toBe(true);
  });

  it("furigana sort falls back to displayName when furigana is unset", () => {
    const mixed = [
      u("1", "ワタナベ", "w@x.jp", "active", undefined, null), // no furigana → use displayName "ワタナベ"
      u("2", "山田", "y@x.jp", "active", undefined, "アイウ"), // furigana "アイウ"
    ];
    // アイウ < ワタナベ in 五十音 → the furigana-less row is ordered by its displayName.
    expect(sortUsers(mixed, { key: "furigana", direction: "asc" }).map((r) => r.id)).toEqual(["2", "1"]);
  });
});
