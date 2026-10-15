import { describe, it, expect } from "vitest";
import { member } from "../src/index";

describe("member.studentId (学籍番号)", () => {
  const parse = (raw: unknown) => member.parsePersonProfileField("studentId", raw);

  it("normalizes full-width digits and whitespace", () => {
    expect(parse("１４００９８０")).toEqual({ ok: true, value: "1400980" });
    expect(parse(" 140 0980 ")).toEqual({ ok: true, value: "1400980" });
    expect(parse("0012345")).toEqual({ ok: true, value: "0012345" });
  });

  it("treats empty as null (optional)", () => {
    expect(parse("")).toEqual({ ok: true, value: null });
    expect(parse("  ")).toEqual({ ok: true, value: null });
    expect(parse(null)).toEqual({ ok: true, value: null });
  });

  it("rejects anything but exactly 7 digits", () => {
    for (const bad of ["140098", "14009801", "a400980", "140-0980", 1400980]) {
      expect(parse(bad)).toEqual({ ok: false });
    }
    expect(member.STUDENT_ID_PATTERN.test("1400980")).toBe(true);
  });

  it("has a label, an error message, and sits next to rosterNumber", () => {
    expect(member.PERSON_PROFILE_LABEL.studentId).toBe("学籍番号");
    expect(member.PERSON_PROFILE_ERROR.studentId).toBe("学籍番号は 1400980 のように 7 桁の数字で入力してください");
    const keys: readonly string[] = member.PERSON_PROFILE_KEYS;
    expect(keys.indexOf("rosterNumber") - keys.indexOf("studentId")).toBe(1);
    expect(member.emptyPersonProfile().studentId).toBeNull();
  });
});
