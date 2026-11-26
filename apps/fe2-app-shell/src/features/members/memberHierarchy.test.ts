// オーガナイザー → リーダー → 配下 の振り分け(組織図・名簿で共有)。
import { describe, expect, it } from "vitest";
import { member } from "@dub/types";
import type { OrgMember } from "./contracts.ts";
import { buildMemberHierarchy, positionOf } from "./memberHierarchy.ts";

const P0 = member.emptyPersonProfile();
const base = { orgId: "o", status: "added" as const, teamIds: [], department: null, grade: null, contact: null, note: null, gmail: null, identityUserId: null, version: 1, createdAt: "t", updatedAt: "t" };
const mk = (id: string, roleTitle: string | null, sortOrder: number, leaderId: string | null = null): OrgMember =>
  ({ ...P0, ...base, id, name: id, roleTitle, sortOrder, leaderId }) as OrgMember;

const ids = (ms: OrgMember[]) => ms.map((m) => m.id);

describe("buildMemberHierarchy", () => {
  const members = [
    mk("memB1", null, 1, "leadB"),
    mk("leadA", "リーダー", 2, "org"),
    mk("memA1", null, 3, "leadA"),
    mk("org", "オーガナイザー", 4),
    mk("leadB", "リーダー", 5),
    mk("memA1x", null, 6, "memA1"),
    mk("free", null, 0),
  ];

  it("splits organizers, leader columns (nested leaderId → first leader up) and unassigned", () => {
    const h = buildMemberHierarchy(members);
    expect(ids(h.organizers)).toEqual(["org"]);
    expect(h.leaders.map((c) => [c.leader.id, ids(c.members)])).toEqual([
      ["leadA", ["memA1", "memA1x"]],
      ["leadB", ["memB1"]],
    ]);
    expect(ids(h.unassigned)).toEqual(["free"]);
  });

  it("puts members whose leaderId chain cycles without reaching a leader into unassigned", () => {
    const h = buildMemberHierarchy([mk("x", null, 1, "y"), mk("y", null, 2, "x"), mk("self", null, 3, "self"), mk("ghost", null, 4, "nope")]);
    expect(h.leaders).toEqual([]);
    expect(ids(h.unassigned).sort()).toEqual(["ghost", "self", "x", "y"]);
  });

  it("stops at the first leader even inside a cycle that passes through one", () => {
    const h = buildMemberHierarchy([mk("L", "リーダー", 1, "m"), mk("m", null, 2, "L")]);
    expect(h.leaders.map((c) => [c.leader.id, ids(c.members)])).toEqual([["L", ["m"]]]);
  });

  it("keeps a leader column when only members match the filter, and drops empty ones", () => {
    const h = buildMemberHierarchy(members, (m) => m.id === "memA1x");
    expect(h.leaders.map((c) => [c.leader.id, c.leaderVisible, ids(c.members)])).toEqual([["leadA", false, ["memA1x"]]]);
    expect(h.organizers).toEqual([]);
    expect(h.unassigned).toEqual([]);
  });

  it("prefers explicit position over roleTitle", () => {
    const lead = { ...mk("p", null, 1), position: "leader" as const };
    const demoted = { ...mk("q", "リーダー", 2, "p"), position: "member" as const };
    expect(positionOf(lead)).toBe("leader");
    const h = buildMemberHierarchy([lead, demoted]);
    expect(h.leaders.map((c) => [c.leader.id, ids(c.members)])).toEqual([["p", ["q"]]]);
  });

  it("does not mutate the input", () => {
    const before = ids(members);
    buildMemberHierarchy(members);
    expect(ids(members)).toEqual(before);
  });
});
