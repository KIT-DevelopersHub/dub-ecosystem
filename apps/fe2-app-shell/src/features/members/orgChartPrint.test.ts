import { describe, expect, it } from "vitest";
import { fitZoom } from "./orgChartPrint.ts";

describe("fitZoom", () => {
  it("小さい組織図は上限まで拡大する", () => {
    expect(fitZoom({ width: 300, height: 200 })).toBe(2);
  });
  it("横長は幅、縦長は高さに合わせる", () => {
    expect(fitZoom({ width: 2124, height: 400 })).toBeCloseTo(0.5);
    expect(fitZoom({ width: 400, height: 1466 })).toBeCloseTo(0.5);
  });
  it("測れない時は等倍のまま", () => {
    expect(fitZoom({ width: 0, height: 0 })).toBe(1);
  });
});
