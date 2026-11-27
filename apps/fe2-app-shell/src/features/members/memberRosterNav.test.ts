// 統合アプリ「運営メンバー・名簿」共有サブナビの active 判定（最長前方一致）。
import { describe, expect, it } from "vitest";
import { MEMBERS_TITLE, MEMBER_VIEWS, activeMembersView, activeSectionId, membersViewDescription } from "./MemberRosterNav.tsx";

describe("activeSectionId", () => {
  it("maps each section root path to its id", () => {
    expect(activeSectionId("/members")).toBe("members");
    expect(activeSectionId("/admin/users")).toBe("roster");
  });

  it("keeps the parent tab highlighted on deeper sub-routes", () => {
    expect(activeSectionId("/admin/users/usr_123")).toBe("roster");
  });

  it("keeps チーム別 / 一覧表 / 組織図 under the one 運営メンバー tab (#901)", () => {
    expect(activeSectionId("/members/roster")).toBe("members");
    expect(activeSectionId("/members/org-chart")).toBe("members");
    expect(activeMembersView("/members")).toBe("teams");
    expect(activeMembersView("/members/roster")).toBe("table");
    expect(activeMembersView("/members/org-chart")).toBe("org-chart");
    expect(activeMembersView("/admin/users")).toBeNull();
    expect(activeMembersView("/members-foo")).toBeNull();
  });

  it("does not surface ロール管理 / 変更履歴 in the roster subnav (own tile / removed)", () => {
    // ロールは独立ランチャータイル、変更履歴の UI は撤去。共有サブナビには載らない。
    expect(activeSectionId("/admin/roles")).toBeNull();
    expect(activeSectionId("/admin/history")).toBeNull();
  });

  it("does not surface 参加届の回答 / オンボーディング案内 (moved to 人事)", () => {
    expect(activeSectionId("/participation")).toBeNull();
    expect(activeSectionId("/participation/list")).toBeNull();
  });

  it("returns null outside the merged app", () => {
    expect(activeSectionId("/events")).toBeNull();
    expect(activeSectionId("/mail")).toBeNull();
    // 前方一致の誤爆防止: /membersXYZ は /members セクションではない
    expect(activeSectionId("/members-foo")).toBeNull();
  });

  it("offers 一覧表 only with members:roster_view (same gate as /members/roster)", () => {
    const byId = new Map(MEMBER_VIEWS.map((v) => [v.id, v.requiredPermissions]));
    expect(byId.get("table")).toContain("members:roster_view");
    expect(byId.get("teams")).toEqual(["app:members:view"]);
    expect(byId.get("org-chart")).toEqual(["app:members:view"]);
  });
});

describe("membersViewDescription", () => {
  it("見出しは揃え、説明文の先頭でどの表示かを伝える (#901)", () => {
    expect(MEMBERS_TITLE).toBe("運営メンバー");
    expect(membersViewDescription("teams", "本文")).toBe("チーム別で表示中。本文");
    expect(membersViewDescription("table", "本文")).toBe("一覧表で表示中。本文");
    expect(membersViewDescription("org-chart", "本文")).toBe("組織図で表示中。本文");
  });
});
