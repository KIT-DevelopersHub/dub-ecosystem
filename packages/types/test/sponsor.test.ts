// スポンサー (名刺) 契約の固定。
import { describe, it, expect } from "vitest";
import { sponsor } from "../src/index";

describe("sponsor business cards", () => {
  it("shows company / person, or a placeholder for a photo-only card", () => {
    expect(sponsor.cardDisplayName({ companyName: "株式会社テスト", personName: "山田 太郎" })).toBe("株式会社テスト / 山田 太郎");
    expect(sponsor.cardDisplayName({ companyName: null, personName: "山田 太郎" })).toBe("山田 太郎");
    expect(sponsor.cardDisplayName({ companyName: " ", personName: null })).toBe("名刺（未入力）");
  });

  it("accepts only image types", () => {
    expect(sponsor.isCardImageType("image/jpeg")).toBe(true);
    expect(sponsor.isCardImageType("application/pdf")).toBe(false);
  });
});
