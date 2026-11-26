// 名簿の表示順(#873): 役職でまとめて オーガナイザー → リーダー → メンバー、同じ役職内は組織図順。
import { describe, expect, it } from "vitest";
import { member } from "@dub/types";
import type { OrgMember } from "./contracts.ts";
import { orgChartOrder, rosterOrder } from "./orgChartOrder.ts";

const P0 = member.emptyPersonProfile();
const base = { orgId: "o", status: "added" as const, teamIds: [], department: null, grade: null, contact: null, note: null, gmail: null, identityUserId: null, version: 1, createdAt: "t", updatedAt: "t" };
const mk = (id: string, roleTitle: string | null, sortOrder: number, leaderId: string | null = null): OrgMember =>
  ({ ...P0, ...base, id, name: id, roleTitle, sortOrder, leaderId }) as OrgMember;

const members = [
  mk("memB1", null, 1, "leadB"),
  mk("leadA", "リーダー", 2),
  mk("memA1", null, 3, "leadA"),
  mk("org", "オーガナイザー", 4),
  mk("leadB", "リーダー", 5),
  mk("memA2", null, 6, "leadA"),
  mk("free", null, 0),
];

describe("rosterOrder", () => {
  it("groups by tier: organizer -> leaders -> members", () => {
    expect(rosterOrder(members).map((m) => m.id)).toEqual(["org", "leadA", "leadB", "memA1", "memA2", "memB1", "free"]);
  });

  it("keeps org-chart order within each tier", () => {
    const chart = orgChartOrder(members).map((m) => m.id);
    const inTier = rosterOrder(members).filter((m) => m.roleTitle === null).map((m) => m.id);
    expect(inTier).toEqual(chart.filter((id) => inTier.includes(id)));
  });

  it("does not mutate input and leaves orgChartOrder interleaved", () => {
    const before = members.map((m) => m.id);
    rosterOrder(members);
    expect(members.map((m) => m.id)).toEqual(before);
    expect(orgChartOrder(members).map((m) => m.id)).toEqual(["org", "leadA", "memA1", "memA2", "leadB", "memB1", "free"]);
  });
});
