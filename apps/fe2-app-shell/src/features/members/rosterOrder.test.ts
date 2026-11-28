import { describe, expect, it } from "vitest";
import { ORGANIZER_ROLE_ID, organizerIdentityIds, rosterOrder, rosterTier } from "./rosterOrder.ts";
import type { OrgMember } from "./contracts.ts";

const m = (id: string, over: Partial<OrgMember> = {}): OrgMember =>
  ({ id, name: id, roleTitle: null, position: null, leaderId: null, identityUserId: null, sortOrder: 0, teamIds: [], ...over }) as OrgMember;

const ids = (xs: OrgMember[]) => xs.map((x) => x.id);

describe("rosterOrder (#873)", () => {
  it("groups Organizer → リーダー → メンバー instead of interleaving leaders and their reports", () => {
    const members = [
      m("memB", { leaderId: "leadB", sortOrder: 1 }),
      m("leadA", { position: "leader", sortOrder: 1 }),
      m("memA2", { leaderId: "leadA", sortOrder: 2 }),
      m("org", { position: "organizer", sortOrder: 9 }),
      m("leadB", { position: "leader", sortOrder: 2 }),
      m("memA1", { leaderId: "leadA", sortOrder: 1 }),
      m("loose", { sortOrder: 0 }),
    ];
    // 組織図順は org, leadA, memA1, memA2, leadB, memB, loose → 役職でまとめる (区分内は組織図順のまま)。
    expect(ids(rosterOrder(members))).toEqual(["org", "leadA", "leadB", "memA1", "memA2", "memB", "loose"]);
  });

  it("prefers position over roleTitle, and falls back to roleTitle when position is unset", () => {
    expect(rosterTier(m("a", { position: "member", roleTitle: "会場リーダー" }))).toBe("member");
    expect(rosterTier(m("b", { roleTitle: "会場リーダー" }))).toBe("leader");
    expect(rosterTier(m("c", { roleTitle: "実行委員長" }))).toBe("organizer");
    expect(rosterTier(m("d"))).toBe("member");
  });

  it("treats the identity Organizer role (org-wide or event-scoped) as Organizer", () => {
    const orgIds = organizerIdentityIds([
      { id: "u_global", roleIds: [ORGANIZER_ROLE_ID] },
      { id: "u_event", roleIds: ["role_sys_member"], scopedRoleIds: [ORGANIZER_ROLE_ID] },
      { id: "u_plain", roleIds: ["role_sys_member"] },
      { id: "u_legacy" }, // scopedRoleIds / roleIds が無い古い形でも落ちない
    ]);
    expect([...orgIds].sort()).toEqual(["u_event", "u_global"]);

    const members = [
      m("lead", { position: "leader", sortOrder: 0 }),
      m("evOrg", { position: "member", identityUserId: "u_event", sortOrder: 1 }),
      m("plain", { identityUserId: "u_plain", sortOrder: 2 }),
    ];
    expect(ids(rosterOrder(members, orgIds))).toEqual(["evOrg", "lead", "plain"]);
    expect(ids(rosterOrder(members))).toEqual(["lead", "evOrg", "plain"]);
  });

  it("does not mutate the input", () => {
    const members = [m("x"), m("y", { position: "organizer" })];
    rosterOrder(members);
    expect(ids(members)).toEqual(["x", "y"]);
  });
});
