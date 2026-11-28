import { describe, expect, it } from "vitest";
import { member } from "../src/index";

const FULL: member.SelfParticipation = {
  lastName: "山田",
  firstName: "太郎",
  lastNameKana: "やまだ",
  firstNameKana: "たろう",
  lastNameRomaji: "Yamada",
  firstNameRomaji: "Taro",
  schoolEmail: "t@school.ac.jp",
  gmail: "t@gmail.com",
  phone: "090-0000-0000",
  grade: "3",
  department: "情報工学科",
  rosterNumber: "3EP2-26",
  studentNumber: "1400980",
  desiredActivity: null,
  note: null,
  contact: null,
  operations: null,
};

describe("missingSelfProfileKeys", () => {
  it("is empty when every reminder field is filled (optional 希望活動・備考 ignored)", () => {
    expect(member.missingSelfProfileKeys(FULL)).toEqual([]);
  });

  it("lists missing fields in display order; blank strings count as missing", () => {
    expect(member.missingSelfProfileKeys({ ...FULL, phone: "  ", gmail: null })).toEqual(["gmail", "phone"]);
  });

  it("treats an unlinked account (all null) as missing every reminder field", () => {
    const empty: member.SelfParticipation = { ...member.emptyPersonProfile(), contact: null, operations: null };
    expect(member.missingSelfProfileKeys(empty)).toEqual([...member.PROFILE_REMINDER_KEYS]);
  });

  it("does not count 姓/名 when the roster already has a display name", () => {
    const legacy: member.SelfParticipation = {
      ...FULL,
      lastName: null,
      firstName: null,
      operations: { name: "山田 太郎", roleTitle: null, status: "added", teams: [], leaderName: null },
    };
    expect(member.missingSelfProfileKeys(legacy)).toEqual([]);
  });
});
