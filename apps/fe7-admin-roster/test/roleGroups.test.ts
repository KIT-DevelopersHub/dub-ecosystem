import { describe, it, expect } from "vitest";
import { groupRoles, matchesRoleQuery, roleDeleteMessage, roleDisplayName, roleGroupOf } from "../src/lib/roleGroups";

const r = (id: string, name: string, isSystem = false) => ({ id, name, isSystem });

// Mirrors the prod identity_roles shapes (system / bot / manual / auto team / auto position).
const PROD_LIKE = [
  r("role_auto_team_dev", "チーム: 開発チーム"),
  r("role_sys_admin", "admin", true),
  r("role_01M4TY5D5X", "commander-bot"),
  r("role_ops_lead", "統括"),
  r("role_auto_position_member", "役職: Member"),
  r("role_sys_member", "member", true),
  r("role_ops_legal", "法務会計"),
  r("role_auto_team_pr", "チーム: 広報チーム"),
];

describe("roleGroupOf", () => {
  it("classifies by isSystem, then id/name prefix, then bot, else 運営ロール", () => {
    expect(roleGroupOf(r("role_sys_admin", "admin", true))).toBe("system");
    expect(roleGroupOf(r("role_auto_team_x", "チーム: Xチーム"))).toBe("team");
    expect(roleGroupOf(r("role_auto_position_x", "役職: Member"))).toBe("position");
    expect(roleGroupOf(r("role_01M4TY5D5X", "commander-bot"))).toBe("other");
    expect(roleGroupOf(r("role_ops_lead", "統括"))).toBe("ops");
  });

  it("falls back to the name prefix when the id is not an auto id", () => {
    expect(roleGroupOf(r("role_x", "チーム: 手動チーム"))).toBe("team");
    expect(roleGroupOf(r("role_y", "役職: Leader"))).toBe("position");
  });

  it("isSystem wins over any prefix; unknown auto prefixes go to その他", () => {
    expect(roleGroupOf(r("role_auto_team_x", "チーム: X", true))).toBe("system");
    expect(roleGroupOf(r("role_auto_future_x", "未来: X"))).toBe("other");
  });
});

describe("groupRoles", () => {
  it("orders sections システム → 運営 → チーム → 役職 → その他 and keeps input order within", () => {
    const groups = groupRoles(PROD_LIKE);
    expect(groups.map((g) => g.id)).toEqual(["system", "ops", "team", "position", "other"]);
    expect(groups.find((g) => g.id === "system")!.roles.map((x) => x.name)).toEqual(["admin", "member"]);
    expect(groups.find((g) => g.id === "ops")!.roles.map((x) => x.name)).toEqual(["統括", "法務会計"]);
    expect(groups.find((g) => g.id === "team")!.roles.map((x) => x.id)).toEqual(["role_auto_team_dev", "role_auto_team_pr"]);
  });

  it("never drops a role and omits empty groups", () => {
    const groups = groupRoles(PROD_LIKE);
    expect(groups.flatMap((g) => g.roles)).toHaveLength(PROD_LIKE.length);
    expect(groupRoles([r("role_sys_admin", "admin", true)]).map((g) => g.id)).toEqual(["system"]);
    expect(groupRoles([])).toEqual([]);
  });

  it("auto groups default to collapsed, the rest open", () => {
    const open = Object.fromEntries(groupRoles(PROD_LIKE).map((g) => [g.id, g.defaultOpen]));
    expect(open).toEqual({ system: true, ops: true, team: false, position: false, other: true });
  });
});

describe("roleDisplayName / matchesRoleQuery", () => {
  it("strips the redundant group prefix but leaves other names intact", () => {
    expect(roleDisplayName(r("role_auto_team_dev", "チーム: 開発チーム"))).toBe("開発チーム");
    expect(roleDisplayName(r("role_auto_position_member", "役職: Member"))).toBe("Member");
    expect(roleDisplayName(r("role_ops_lead", "統括"))).toBe("統括");
    expect(roleDisplayName(r("role_auto_team_empty", "チーム:"))).toBe("チーム:");
  });

  it("matches by full name, case-insensitively; empty query matches all", () => {
    expect(matchesRoleQuery(r("a", "Admin"), "adm")).toBe(true);
    expect(matchesRoleQuery(r("a", "チーム: 開発チーム"), "チーム")).toBe(true);
    expect(matchesRoleQuery(r("a", "統括"), "開発")).toBe(false);
    expect(matchesRoleQuery(r("a", "統括"), "  ")).toBe(true);
  });
});

describe("roleDeleteMessage", () => {
  it("states the impact on holders only when someone holds the role", () => {
    expect(roleDeleteMessage(r("role_x", "統括"))).toBe("「統括」を削除します。元に戻せません。");
    expect(roleDeleteMessage({ ...r("role_x", "統括"), memberCount: 3 })).toContain("付与中の 3 人から");
  });

  it("warns that 名簿-managed roles come back on the next sync", () => {
    expect(roleDeleteMessage(r("role_auto_team_dev", "チーム: 開発チーム"))).toContain("次回の同期");
    expect(roleDeleteMessage(r("role_auto_position_member", "役職: Member"))).toContain("次回の同期");
    expect(roleDeleteMessage(r("role_ops_lead", "統括"))).not.toContain("次回の同期");
  });
});
