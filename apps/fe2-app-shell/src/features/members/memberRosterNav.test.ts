// 統合アプリ「運営メンバー・名簿」共有サブナビの active 判定（最長前方一致）。
import { describe, expect, it } from "vitest";
import { activeSectionId } from "./MemberRosterNav.tsx";

describe("activeSectionId", () => {
  it("maps each section root path to its id", () => {
    expect(activeSectionId("/members")).toBe("members");
    expect(activeSectionId("/admin/users")).toBe("roster");
    expect(activeSectionId("/admin/roles")).toBe("roles");
    expect(activeSectionId("/admin/history")).toBe("history");
  });

  it("keeps the parent tab highlighted on deeper sub-routes", () => {
    expect(activeSectionId("/admin/users/usr_123")).toBe("roster");
    expect(activeSectionId("/admin/roles/new")).toBe("roles");
  });

  it("returns null outside the merged app", () => {
    expect(activeSectionId("/events")).toBeNull();
    expect(activeSectionId("/mail")).toBeNull();
    // 前方一致の誤爆防止: /membersXYZ は /members セクションではない
    expect(activeSectionId("/members-foo")).toBeNull();
  });
});
