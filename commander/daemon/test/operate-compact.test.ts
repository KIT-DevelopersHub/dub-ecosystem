// Read compaction: every row survives (no character-count truncation), columns follow the
// entry's hint, and the `[field~value]` selector turns a name into an id.
import { compactRead, hintFields } from "../src/operate/compact.ts";
import { findEntry } from "../src/operate/catalog.ts";
import { getPath, resolveValue } from "../src/operate/plan.ts";

const task = (i: number) => ({
  id: `task_${i}`,
  eventId: "ev1",
  title: `タスク${i}`,
  description: "長い説明".repeat(50),
  status: i % 2 ? "todo" : "done",
  priority: "low",
  assigneeId: i % 3 ? null : `user_${i}`,
  teamId: i === 400 ? "member_team_corp" : "member_team_ops",
  parentTaskId: null,
  createdBy: "user_admin",
  dueAt: "2026-11-01T00:00:00.000Z",
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});

describe("compactRead", () => {
  it("keeps every row of a large list (the old 1500-char sample kept 1-2)", () => {
    const items = Array.from({ length: 400 }, (_, i) => task(i + 1));
    const c = compactRead({ items, nextCursor: null }, findEntry("tasks.list")!.hint);
    const lines = c.text.split("\n");
    expect(lines[0]).toBe("items（400件）");
    expect(lines.filter((l) => l.startsWith("| task_"))).toHaveLength(400);
    expect(c.text).toContain("| task_400 | ev1 | タスク400 | done | low | - | member_team_corp |");
    expect(c.rows).toBe(400);
    expect(c.bytes).toBe(Buffer.byteLength(c.text));
  });

  it("drops fields the hint does not name, and noise like version / createdAt", () => {
    const c = compactRead({ items: [task(1)] }, findEntry("tasks.list")!.hint);
    const header = c.text.split("\n")[1]!;
    expect(header).toBe("| id | eventId | title | status | priority | assigneeId | teamId | dueAt |");
    expect(c.text).not.toContain("長い説明");
    expect(c.text).not.toContain("createdAt");
  });

  it("renders nested lists of an object response as their own tables", () => {
    const ov = {
      teams: [{ id: "member_team_corp", key: "houjin", name: "法人チーム", color: "#7c3aed" }],
      members: [
        { id: "m1", name: "野村", status: "added", teamIds: ["member_team_corp", "member_team_hq"], identityUserId: null, contact: "x@y", sortOrder: 1 },
      ],
    };
    const c = compactRead(ov, findEntry("members.overview")!.hint);
    expect(c.text).toBe(
      ["teams（1件）", "| id | name |", "|---|---|", "| member_team_corp | 法人チーム |",
       "members（1件）", "| id | name | status | teamIds | identityUserId |", "|---|---|---|---|---|", "| m1 | 野村 | added | member_team_corp, member_team_hq | - |"].join("\n"),
    );
    expect(c.rows).toBe(2);
  });

  it("gives each forEach call its own section, named by the call's target", () => {
    const c = compactRead([{ items: [task(1)] }, { items: [] }], findEntry("tasks.list")!.hint, ["北陸", "LT会"]);
    expect(c.text).toMatch(/^■ 北陸\nitems（1件）/);
    expect(c.text).toContain("■ LT会\nitems（0件）");
    expect(c.rows).toBe(1);
  });

  it("cuts a single over-long cell but never a row, and escapes table pipes", () => {
    const c = compactRead([{ id: "x", body: `a|b\n${"あ".repeat(300)}` }], "id・body");
    expect(c.text).toContain("| x | a／b ");
    expect(c.text).toContain("…（全");
  });

  it("never cuts a list cell (permissions[] is data, not prose)", () => {
    const permissions = Array.from({ length: 80 }, (_, i) => `app:feature${i}:edit`);
    const c = compactRead({ items: [{ id: "r1", name: "admin", permissions }] }, findEntry("roles.list")!.hint);
    expect(c.text).toContain("app:feature79:edit");
    expect(c.text).not.toContain("…（全");
  });

  it("falls back to scalar columns when the hint names none of them", () => {
    expect(compactRead([{ a: 1, b: [1, 2], c: [{ x: 1 }] }], undefined).text).toBe(["（1件）", "| a | b |", "|---|---|", "| 1 | 1, 2 |"].join("\n"));
    expect(hintFields("items[].id・title")).toEqual(new Set(["items", "id", "title"]));
  });

  it("says when a list has more pages", () => {
    expect(compactRead({ items: [], nextCursor: "abc" }, "items[].id").text).toContain("nextCursor: 続きあり");
  });
});

describe("getPath selectors", () => {
  const scope = { teams: { teams: [{ id: "member_team_ops", name: "当日進行チーム" }, { id: "member_team_corp", name: "法人チーム" }] } };

  it("[field~value] picks the first element containing the value", () => {
    expect(getPath(scope, "teams.teams[name~法人].id")).toBe("member_team_corp");
    expect(resolveValue("{{teams.teams[name~当日進行].id}}", scope)).toBe("member_team_ops");
  });

  it("[field=value] needs an exact (case-insensitive) match", () => {
    expect(getPath(scope, "teams.teams[name=法人].id")).toBeUndefined();
    expect(getPath(scope, "teams.teams[name=法人チーム].id")).toBe("member_team_corp");
  });

  it("an unmatched selector stays a placeholder (so the preview blocks instead of guessing)", () => {
    expect(resolveValue("{{teams.teams[name~存在しない].id}}", scope)).toBe("{{teams.teams[name~存在しない].id}}");
  });
});
