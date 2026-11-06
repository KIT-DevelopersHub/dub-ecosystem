import { describe, expect, it } from "vitest";
import { EMPTY_FORM } from "./SponsorShared.tsx";
import { mergeDraft, normalizeLine, parseCardText } from "./parseCardText.ts";

describe("parseCardText", () => {
  it("reads a typical Japanese card (OCR の文字間スペース・全角を含む)", () => {
    const text = [
      "株 式 会 社 能 登 ソ フ ト",
      "営 業 本 部 第 一 営 業 部 部 長",
      "山 田 太 郎",
      "Taro Yamada",
      "〒920-1192 石川県金沢市角間町",
      "TEL 076-123-4567 FAX 076-123-4568",
      "携帯 090-1111-2222",
      "Ｅ-mail: taro.yamada @ noto-soft.co.jp",
      "https://noto-soft.co.jp",
    ].join("\n");
    expect(parseCardText(text)).toEqual({
      companyName: "株式会社能登ソフト",
      department: "営業本部第一営業部",
      title: "部長",
      personName: "山田太郎",
      email: "taro.yamada@noto-soft.co.jp",
      phone: "090-1111-2222",
    });
  });

  it("splits department and title on separate tokens and picks a name after the title", () => {
    const d = parseCardText(["ABC Inc.", "開発本部 シニアエンジニア", "代表取締役社長 佐藤花子", "03-1234-5678"].join("\n"));
    expect(d.companyName).toBe("ABC Inc.");
    expect(d.department).toBe("開発本部");
    expect(d.title).toBe("シニアエンジニア");
    expect(d.personName).toBe("佐藤花子");
    expect(d.phone).toBe("03-1234-5678");
  });

  it("does not treat a name ending in 部 as a department, and skips FAX-only lines", () => {
    const d = parseCardText(["阿部 一郎", "FAX 03-9999-0000", "Tel: 03-1111-2222"].join("\n"));
    expect(d.personName).toBe("阿部一郎");
    expect(d.department).toBeUndefined();
    expect(d.phone).toBe("03-1111-2222");
  });

  it("returns nothing for unreadable text", () => {
    expect(parseCardText("~ ' . |\n\n")).toEqual({});
  });
});

describe("normalizeLine / mergeDraft", () => {
  it("normalizes width and CJK gaps but keeps latin word spaces", () => {
    expect(normalizeLine("  Ｔａｒｏ　Ｙａｍａｄａ  ")).toBe("Taro Yamada");
    expect(normalizeLine("山 田  太 郎")).toBe("山田太郎");
  });

  it("fills only empty fields and never overwrites what the user typed", () => {
    const { next, filled } = mergeDraft({ ...EMPTY_FORM, companyName: "手入力" }, { companyName: "OCR社", personName: "山田太郎" });
    expect(next.companyName).toBe("手入力");
    expect(next.personName).toBe("山田太郎");
    expect(filled).toEqual(["personName"]);
  });

  it("replaces values the previous read filled in, unless the user edited them (撮り直し)", () => {
    const form = { ...EMPTY_FORM, companyName: "前の写真の会社", personName: "直した氏名" };
    const prevAuto = { companyName: "前の写真の会社", personName: "前の写真の氏名" };
    const { next } = mergeDraft(form, { companyName: "新しい会社", personName: "新しい氏名" }, prevAuto);
    expect(next.companyName).toBe("新しい会社");
    expect(next.personName).toBe("直した氏名");
  });
});
