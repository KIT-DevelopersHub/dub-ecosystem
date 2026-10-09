// 運営名簿と参加届の項目が今後もブレないことを守るテスト。
import { describe, expect, it } from "vitest";
import { member } from "@dub/types";
import {
  PERSON_PROFILE_FIELDS,
  PROFILE_DISPLAY_COLUMNS,
  emptyProfileDraft,
  formatProfileValue,
  parseProfileDraft,
  splitDisplayName,
} from "./personProfile.tsx";

const ALL = [...member.PERSON_PROFILE_KEYS].sort();

describe("personProfile (運営名簿と参加届の共通項目)", () => {
  it("入力フォームは PersonProfile の全項目を 1 回ずつ持つ", () => {
    expect(PERSON_PROFILE_FIELDS.map((f) => f.key).sort()).toEqual(ALL);
  });

  it("一覧・ダウンロードの列は 氏名列 + 全項目を網羅する", () => {
    const covered = PROFILE_DISPLAY_COLUMNS.flatMap((c) => c.keys);
    expect(new Set(covered).size).toBe(covered.length);
    // 苗字/名前 は各画面の「氏名」列が表示する。
    expect([...covered, "lastName", "firstName"].sort()).toEqual(ALL);
  });

  it("サーバと同じルールで正規化・検証する", () => {
    const draft = { ...emptyProfileDraft(), lastName: " 山田 ", grade: "3年", rosterNumber: "３ep２ー２６", gmail: "bad" };
    const { profile, errors } = parseProfileDraft(draft, ["lastName", "schoolEmail"]);
    expect(profile.lastName).toBe("山田");
    expect(profile.grade).toBe("3");
    expect(profile.rosterNumber).toBe("3EP2-26");
    expect(errors.gmail).toBe("メールアドレスの形式が正しくありません");
    expect(errors.schoolEmail).toBe("学校のメールアドレスを入力してください");
    expect(errors.lastName).toBeUndefined();
  });

  it("学年・希望活動はラベルで表示する", () => {
    expect(formatProfileValue("grade", { grade: "graduate" })).toBe("院生");
    expect(formatProfileValue("desiredActivity", { desiredActivity: "dev" })).toBe("チーム開発");
  });

  it("姓/名 の無い旧データは表示名を分けて編集できる", () => {
    expect(splitDisplayName("山田 太郎")).toEqual({ lastName: "山田", firstName: "太郎" });
    expect(splitDisplayName("山田太郎")).toEqual({ lastName: "山田太郎", firstName: "" });
  });
});
