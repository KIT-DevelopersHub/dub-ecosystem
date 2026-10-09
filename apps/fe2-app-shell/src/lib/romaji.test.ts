import { describe, it, expect } from "vitest";
import { kanaToRomaji } from "./romaji.ts";

describe("kanaToRomaji (簡易ヘボン式プリフィル)", () => {
  it("converts basic hiragana and title-cases the result", () => {
    expect(kanaToRomaji("やまだ")).toBe("Yamada");
    expect(kanaToRomaji("たろう")).toBe("Tarou");
    expect(kanaToRomaji("こうかい")).toBe("Koukai");
  });

  it("handles digraphs (拗音) and long-vowel marks", () => {
    expect(kanaToRomaji("きょうこ")).toBe("Kyouko");
    expect(kanaToRomaji("しゅう")).toBe("Shuu");
    expect(kanaToRomaji("とーる")).toBe("Toru"); // ー は無視
  });

  it("accepts katakana input by folding to hiragana", () => {
    expect(kanaToRomaji("タナカ")).toBe("Tanaka");
  });

  it("doubles the consonant for 促音 (っ)", () => {
    expect(kanaToRomaji("はっとり")).toBe("Hattori");
  });

  it("drops unconvertible characters (漢字) and trims", () => {
    expect(kanaToRomaji("  やま田  ")).toBe("Yama");
    expect(kanaToRomaji("")).toBe("");
  });
});
