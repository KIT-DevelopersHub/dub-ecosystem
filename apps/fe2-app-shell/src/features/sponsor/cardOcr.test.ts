import { describe, expect, it } from "vitest";
import { largeRows, replaceRows } from "./cardOcr.ts";

const at = (text: string, x0: number, y0: number, w: number, h: number) => ({ text, bbox: { x0, y0, x1: x0 + w, y1: y0 + h } });

describe("largeRows / replaceRows (大きい文字の行の読み直し)", () => {
  it("groups pieces of a large name on one row and skips small lines", () => {
    const lines = [at("株式会社大和精密", 150, 110, 400, 40), at("に 所", 149, 362, 76, 56), at("野", 243, 345, 80, 76), at("正樹", 530, 353, 176, 79)];
    const rows = largeRows(lines);
    expect(rows).toHaveLength(1);
    // 「に 所」(誤読された「宇」) も半分以上の高さなので含める。
    expect(rows[0]!.members).toEqual([2, 3, 1]);
    expect(rows[0]!.box).toEqual({ x0: 149, y0: 345, x1: 706, y1: 432 });
  });

  it("does not join a large line with a much smaller one in the same row", () => {
    const rows = largeRows([at("株式会社ハルカゼ", 60, 50, 400, 70), at("クリエイティブ部", 600, 60, 300, 140)]);
    expect(rows).toHaveLength(2);
  });

  it("replaces the pieces with the re-read text and keeps them when the re-read is empty", () => {
    const lines = [at("製造部 工場長", 150, 265, 200, 35), at("野", 243, 345, 80, 76), at("正樹", 530, 353, 176, 79), at("ロゴ", 100, 10, 200, 90)];
    const rows = largeRows(lines);
    const next = replaceRows(lines, rows, rows.map((r) => (r.members.includes(1) ? "宇野 正樹\n" : " ")));
    expect(next.map((l) => l.text)).toEqual(["製造部 工場長", "ロゴ", "宇野 正樹"]);
  });
});
