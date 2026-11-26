// 運営名簿「階層で見る」(#873) のまとめ方。
import { describe, expect, it } from "vitest";
import { member } from "@dub/types";
import type { OrgMember } from "./contracts.ts";
import { buildRosterHierarchy, flattenRosterHierarchy } from "./rosterHierarchy.ts";

const P0 = member.emptyPersonProfile();
const base = { orgId: "o", status: "added" as const, teamIds: [], department: null, grade: null, contact: null, note: null, gmail: null, identityUserId: null, version: 1, createdAt: "t", updatedAt: "t" };
const mk = (id: string, roleTitle: string | null, sortOrder: number, leaderId: string | null = null, position: OrgMember["position"] = null): OrgMember =>
  ({ ...P0, ...base, id, name: id, roleTitle, sortOrder, leaderId, position }) as OrgMember;

const members = [
  mk("org1", "オーガナイザー", 0),
  mk("org2", "副代表", 1, null, "organizer"),
  mk("leadA", "開発リーダー", 2, "org1"),
  mk("memA1", "メンバー", 3, "leadA"),
  mk("leadB", "広報", 4, "org2", "leader"),
  mk("memB1", null, 5, "leadB"),
  mk("subB", null, 6, "memB1"),
  mk("memA2", null, 7, "leadA"),
  mk("free", null, 8),
  mk("underOrg", null, 9, "org1"),
];
const ids = (xs: OrgMember[]) => xs.map((m) => m.id);

describe("buildRosterHierarchy", () => {
  it("オーガナイザー / リーダー列(配下つき) / リーダー未設定 に分ける", () => {
    const h = buildRosterHierarchy(members);
    expect(ids(h.organizers)).toEqual(["org1", "org2"]);
    expect(h.leaders.map((c) => [c.leader.id, ids(c.members)])).toEqual([
      ["leadA", ["memA1", "memA2"]],
      ["leadB", ["memB1", "subB"]],
    ]);
    expect(ids(h.unassigned)).toEqual(["underOrg", "free"]);
  });

  it("絞り込み: 配下だけ合う列はリーダーを薄く出し、誰も出ない列は消す", () => {
    const h = buildRosterHierarchy(members, (m) => m.id === "memA2");
    expect(h.organizers).toEqual([]);
    expect(h.unassigned).toEqual([]);
    expect(h.leaders.map((c) => [c.leader.id, c.leaderVisible, ids(c.members)])).toEqual([["leadA", false, ["memA2"]]]);
    expect(ids(flattenRosterHierarchy(h))).toEqual(["memA2"]);
  });

  it("書き出し順は オーガナイザー → リーダー → 各リーダーの配下 → 未設定", () => {
    expect(ids(flattenRosterHierarchy(buildRosterHierarchy(members)))).toEqual([
      "org1", "org2", "leadA", "leadB", "memA1", "memA2", "memB1", "subB", "underOrg", "free",
    ]);
  });

  it("leaderId の循環でも止まり、未設定に入れる", () => {
    const h = buildRosterHierarchy([mk("x", null, 0, "y"), mk("y", null, 1, "x")]);
    expect(ids(h.unassigned)).toEqual(["x", "y"]);
  });
});
