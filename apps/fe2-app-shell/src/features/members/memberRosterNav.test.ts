// 統合アプリ「運営メンバー・名簿」共有サブナビの active 判定（最長前方一致）。
import { describe, expect, it } from "vitest";
import { activeSectionId } from "./MemberRosterNav.tsx";

describe("activeSectionId", () => {
  it("maps each section root path to its id", () => {
    expect(activeSectionId("/members")).toBe("members");
    expect(activeSectionId("/members/org-chart")).toBe("org-chart");
    expect(activeSectionId("/admin/users")).toBe("roster");
  });

  it("運営名簿は運営メンバータブに統合: 旧 /members/roster は運営メンバータブ扱い (#901)", () => {
    expect(activeSectionId("/members/roster")).toBe("members");
  });

  it("keeps the parent tab highlighted on deeper sub-routes", () => {
    expect(activeSectionId("/admin/users/usr_123")).toBe("roster");
    // /members/org-chart は組織図（最長一致で /members より組織図が勝つ）
    expect(activeSectionId("/members/org-chart")).toBe("org-chart");
    expect(activeSectionId("/members")).toBe("members");
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
});
