// 人事ステータスの遷移規則 (SoT) の固定。
import { describe, it, expect } from "vitest";
import { hr } from "../src/index";

describe("hr statuses", () => {
  it("are the 8 HR statuses in display order with Japanese labels", () => {
    expect(hr.APPLICANT_STAGES.map((s) => hr.APPLICANT_STAGE_LABELS[s])).toEqual([
      "面談日程調整中", "面談確定", "面談済み", "採用", "不採用", "オンボーディング調整", "オンボーディング完了", "辞退",
    ]);
  });

  it("is permissive (can move back) but never puts a non-member into a roster status", () => {
    expect(hr.canTransition("interviewed", "scheduling", false)).toBe(true);
    expect(hr.canTransition("onboarded", "interviewed", true)).toBe(true);
    for (const s of hr.APPLICANT_STAGES) if (s !== "withdrawn") expect(hr.canTransition(s, "withdrawn", false)).toBe(true);
    for (const to of hr.ROSTER_STAGES) {
      expect(hr.canTransition("interviewed", to, false)).toBe(false);
      expect(hr.requiresJoin(to, false)).toBe(true);
      expect(hr.canTransition("rejected", to, true)).toBe(true);
    }
    expect(hr.canTransition("hired", "hired", true)).toBe(false);
  });
});
