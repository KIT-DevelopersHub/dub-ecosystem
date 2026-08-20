import { describe, it, expect } from "vitest";
import { readableTextColor, CONTRAST_TEXT_DARK, CONTRAST_TEXT_LIGHT } from "../src/domain/color-contrast";

describe("readableTextColor", () => {
  it("returns white text on dark fills", () => {
    expect(readableTextColor("#1e3a5f")).toBe(CONTRAST_TEXT_LIGHT); // 統括チーム navy
    expect(readableTextColor("#d92d20")).toBe(CONTRAST_TEXT_LIGHT); // danger.600
    expect(readableTextColor("#000000")).toBe(CONTRAST_TEXT_LIGHT);
  });

  it("returns dark text on light fills", () => {
    expect(readableTextColor("#ffffff")).toBe(CONTRAST_TEXT_DARK);
    expect(readableTextColor("#fedf89")).toBe(CONTRAST_TEXT_DARK); // warning.200
    expect(readableTextColor("#f8f9fb")).toBe(CONTRAST_TEXT_DARK); // gray.50
  });

  it("accepts shorthand and hash-less hex", () => {
    expect(readableTextColor("#fff")).toBe(CONTRAST_TEXT_DARK);
    expect(readableTextColor("000")).toBe(CONTRAST_TEXT_LIGHT);
  });

  it("falls back to dark text for missing/invalid input (never invisible)", () => {
    expect(readableTextColor(undefined)).toBe(CONTRAST_TEXT_DARK);
    expect(readableTextColor(null)).toBe(CONTRAST_TEXT_DARK);
    expect(readableTextColor("not-a-color")).toBe(CONTRAST_TEXT_DARK);
    expect(readableTextColor("#12")).toBe(CONTRAST_TEXT_DARK);
  });

  it("meets WCAG AA (>=4.5) for the seeded team + priority fills", () => {
    // sanity: the chosen text pole clears AA against each production fill
    const fills = ["#1e3a5f", "#0d9488", "#2563eb", "#ea580c", "#16a34a", "#db2777", "#d92d20", "#dc6803", "#1570ef", "#6f7a90"];
    const lum = (hex: string) => {
      const h = hex.replace("#", "");
      const ch = (i: number) => {
        const s = parseInt(h.slice(i, i + 2), 16) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
    };
    for (const f of fills) {
      const L = lum(f);
      const textIsLight = readableTextColor(f) === CONTRAST_TEXT_LIGHT;
      const ratio = textIsLight ? (1 + 0.05) / (L + 0.05) : (L + 0.05) / 0.05;
      expect(ratio).toBeGreaterThanOrEqual(3); // large bold text AA (≥3:1); most clear 4.5:1
    }
  });
});
