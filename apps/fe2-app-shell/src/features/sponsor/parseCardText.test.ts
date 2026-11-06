import { describe, expect, it } from "vitest";
import { EMPTY_FORM } from "./SponsorShared.tsx";
import { mergeDraft, normalizeLine, parseCardLines, parseCardText } from "./parseCardText.ts";

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

// 位置つきの行を作る。size = 文字の高さ。
const at = (text: string, y: number, size: number, x = 60) => ({ text, bbox: { x0: x, y0: y, x1: x + size * text.length, y1: y + size } });

describe("parseCardLines (Tesseract の実出力に基づく)", () => {
  it("does not put a brand without a legal form into the person name", () => {
    const lines = [at("加賀 テッ ク", 60, 65), at("エン ジニ ア", 200, 27), at("高橋 美咲", 290, 63), at("東京 都 千代 田 区 丸の内 1-1-1", 430, 24)];
    expect(parseCardLines(lines)).toEqual({ companyName: "加賀テック", title: "エンジニア", personName: "高橋美咲" });
  });

  it("tells a kanji company from a name even when the company is larger", () => {
    const d = parseCardLines([at("北陸 電機 工業", 60, 70), at("技術 部 主任", 200, 25), at("中村 健太", 240, 60)]);
    expect(d.companyName).toBe("北陸電機工業");
    expect(d.personName).toBe("中村健太");
    expect(d.department).toBe("技術部");
    expect(d.title).toBe("主任");
  });

  it("prefers the line next to the title for a surname outside the list", () => {
    const d = parseCardLines([at("三ツ星 堂", 60, 60), at("営業 課 担当", 200, 25), at("西尾 健", 240, 60)]);
    expect(d.companyName).toBe("三ツ星堂");
    expect(d.personName).toBe("西尾健");
  });

  it("uses the email domain to recognize latin company names", () => {
    const d = parseCardLines([at("Hokuriku Data Lab", 60, 45), at("CTO", 200, 25), at("Kenji Ota", 240, 60)], "ota@hokuriku-data.jp");
    expect(d.companyName).toBe("Hokuriku Data Lab");
    expect(d.personName).toBe("Kenji Ota");
    expect(d.title).toBe("CTO");
  });

  it("uses the email local part to find a latin name", () => {
    const d = parseCardLines([at("Blue Harbor", 60, 60), at("Daniel Moore", 200, 40)], "daniel.moore@bh.example.com");
    expect(d.personName).toBe("Daniel Moore");
    expect(d.companyName).toBe("Blue Harbor");
  });

  it("keeps a whole english title line", () => {
    expect(parseCardLines([at("Senior Software Engineer", 60, 30)]).title).toBe("Senior Software Engineer");
  });

  it("does not take a tagline or furigana for the name", () => {
    const d = parseCardLines([at("未来 を つく る 技術", 20, 24), at("株 式 会 社 テ クノ 能登", 60, 44), at("代表 社員", 150, 26), at("わたなべ しょう", 190, 24), at("渡辺 翔", 220, 70)]);
    expect(d.companyName).toBe("株式会社テクノ能登");
    expect(d.title).toBe("代表社員");
    expect(d.personName).toBe("渡辺翔");
  });

  it("does not guess a katakana company as the name when the name is unreadable", () => {
    const d = parseCardLines([at("クラ ウド ワニ ンス", 60, 36), at("セー ルス 部 コン サル タン ト", 150, 20), at("2 必 剛 ス 本", 190, 40)]);
    expect(d.personName).toBeUndefined();
    expect(d.companyName).toBe("クラウドワニンス");
  });

  it("joins a name split at the gap between family and given name", () => {
    const d = parseCardLines([at("株式会社大和精密", 60, 42), at("宇野", 250, 66), at("正樹", 252, 66, 387)]);
    expect(d.personName).toBe("宇野正樹");
  });

  it("does not join lines in separate columns", () => {
    const d = parseCardLines([at("人事 部", 100, 30), at("佐藤 花子", 100, 30, 600)]);
    expect(d.department).toBe("人事部");
    expect(d.personName).toBe("佐藤花子");
  });

  it("reads a name written before the title", () => {
    expect(parseCardLines([at("山田太郎 部長", 100, 40)])).toEqual({ title: "部長", personName: "山田太郎" });
  });

  it("ignores scratch lines and keeps the real one", () => {
    expect(parseCardLines([at("ーー", 20, 10), at("ー", 34, 10), at("株式会社ハルカゼ", 60, 40)]).companyName).toBe("株式会社ハルカゼ");
  });

  it("joins several department lines", () => {
    const d = parseCardLines([at("経営 企画 本部", 100, 26), at("DX 推進 室 主査", 130, 26)]);
    expect(d.department).toBe("経営企画本部 DX 推進室");
    expect(d.title).toBe("主査");
  });
});

describe("メール・電話 (2 パス目の英語モデル)", () => {
  it("prefers digits and letters from the latin pass", () => {
    const d = parseCardText("TEL 076-123-4367 / FAX 076-123-4368\nE-mail: taro@noto-softcojp", "TEL 076-123-4567 / FAX 076-123-4568\nE-mail: taro@noto-soft.co.jp");
    expect(d.phone).toBe("076-123-4567");
    expect(d.email).toBe("taro@noto-soft.co.jp");
  });

  it("inherits japanese labels the latin pass could not read", () => {
    const d = parseCardText(["ファクス 03-1111-2229", "電話 03-1111-2222"].join("\n"), ["HF 03-1111-2229", "HH 03-1111-2222"].join("\n"));
    expect(d.phone).toBe("03-1111-2222");
  });

  it("prefers a mobile number by its prefix", () => {
    expect(parseCardText("TEL 03-1111-2222 携帯 090-1111-2223").phone).toBe("090-1111-2223");
    expect(parseCardText("+81 (0)3 6000 1234").phone).toBe("+81-(0)3-6000-1234");
  });

  it("falls back to the first pass when the latin pass found nothing", () => {
    expect(parseCardText("TEL 03-1234-5678\na@b.co.jp", "garbage").phone).toBe("03-1234-5678");
    expect(parseCardText("TEL 03-1234-5678\na@b.co.jp", "garbage").email).toBe("a@b.co.jp");
  });

  it.each([
    ["misaki@kaga-tech jp", "misaki@kaga-tech.jp"],
    ["taro@noto-soft co jp", "taro@noto-soft.co.jp"],
    ["taro @sakura-net example jp", "taro@sakura-net.example.jp"],
    ["taro@noto-softcojp", "taro@noto-soft.co.jp"],
    ["okada@digital-hokuriku.orjp", "okada@digital-hokuriku.or.jp"],
    ["misaki@kaga-techjjp", "misaki@kaga-tech.jp"],
  ])("repairs a broken domain: %s", (raw, want) => {
    expect(parseCardText(raw).email).toBe(want);
  });

  it("takes the longer email when the latin pass lost the head", () => {
    expect(parseCardText("sakura.morita@harukaze.jp", "morita@harukaze.jp").email).toBe("sakura.morita@harukaze.jp");
  });

  it("repairs letters in a phone number and rejects number-like noise", () => {
    expect(parseCardText("TEL 0768-22-1lii").phone).toBe("0768-22-1111");
    expect(parseCardText("〒070-0031").phone).toBeUndefined();
    expect(parseCardText("090-1234").phone).toBeUndefined();
  });

  it("does not treat a TEL line without a space as a name or company", () => {
    expect(parseCardText("TEL03-7777-1111").companyName).toBeUndefined();
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
