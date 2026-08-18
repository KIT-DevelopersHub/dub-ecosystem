// 統合アプリ「運営メンバー・名簿」共有サブナビの active 判定（最長前方一致）。
import { describe, expect, it } from "vitest";
import { activeSectionId } from "./MemberRosterNav.tsx";

describe("activeSectionId", () => {
  it("maps each section root path to its id", () => {
    expect(activeSectionId("/members")).toBe("members");
    expect(activeSectionId("/admin/users")).toBe("roster");
    expect(activeSectionId("/participation")).toBe("participation");
    expect(activeSectionId("/participation/list")).toBe("participation-list");
  });

  it("keeps the parent tab highlighted on deeper sub-routes", () => {
    expect(activeSectionId("/admin/users/usr_123")).toBe("roster");
    // /participation/list は独立タブ（最長一致で 提出フォームより回答一覧が勝つ）
    expect(activeSectionId("/participation/list")).toBe("participation-list");
  });

  it("does not surface ロール管理 / 変更履歴 in the roster subnav (own tile / removed)", () => {
    // ロールは独立ランチャータイル、変更履歴の UI は撤去。共有サブナビには載らない。
    expect(activeSectionId("/admin/roles")).toBeNull();
    expect(activeSectionId("/admin/history")).toBeNull();
  });

  it("returns null outside the merged app", () => {
    expect(activeSectionId("/events")).toBeNull();
    expect(activeSectionId("/mail")).toBeNull();
    // 前方一致の誤爆防止: /membersXYZ は /members セクションではない
    expect(activeSectionId("/members-foo")).toBeNull();
  });
});
