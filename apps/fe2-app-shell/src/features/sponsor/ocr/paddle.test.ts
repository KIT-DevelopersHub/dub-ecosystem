import { describe, expect, it } from "vitest";
import { ctcDecode, detBoxes, detSize, isVertical, minAreaRect, recWidth, rectCorners, stretchContrast, toTensor } from "./paddle.ts";

describe("PP-OCR の前処理・後処理", () => {
  it("fits the detector input to 736px and multiples of 32 without upscaling", () => {
    expect(detSize(1600, 1000)).toEqual({ width: 736, height: 448 });
    expect(detSize(500, 300)).toEqual({ width: 512, height: 288 });
  });

  it("builds a BGR tensor scaled to -1..1", () => {
    const t = toTensor({ data: new Uint8ClampedArray([255, 0, 127.5, 255]), width: 1, height: 1 });
    expect(Array.from(t)).toEqual([expect.closeTo(0, 2), -1, 1]);
  });

  it("stretches a dim photo to the full range", () => {
    const px = { data: new Uint8ClampedArray(Array.from({ length: 100 }, (_, i) => [60 + i, 60 + i, 60 + i, 255]).flat()), width: 100, height: 1 };
    stretchContrast(px);
    expect(px.data[0]).toBe(0);
    expect(px.data[99 * 4]).toBe(255);
  });

  it("finds the minimum-area rectangle of a rotated block", () => {
    const pts: [number, number][] = [];
    const a = (10 * Math.PI) / 180;
    for (let u = 0; u <= 40; u++) for (let v = 0; v <= 10; v++) pts.push([100 + u * Math.cos(a) - v * Math.sin(a), 50 + u * Math.sin(a) + v * Math.cos(a)]);
    const r = minAreaRect(pts);
    expect(r.w).toBeCloseTo(40, 0);
    expect(r.h).toBeCloseTo(10, 0);
    expect(r.angle).toBeCloseTo(a, 2);
    expect(rectCorners(r)).toHaveLength(4);
  });

  it("detects separate text lines from a probability map and grows them", () => {
    const w = 64;
    const h = 32;
    const prob = new Float32Array(w * h);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) prob[y * w + x] = 0.9;
    };
    fill(4, 4, 40, 9);
    fill(4, 20, 30, 25);
    prob[2 * w + 60] = 0.9; // 1 画素のノイズは捨てる
    const boxes = detBoxes(prob, w, h);
    expect(boxes).toHaveLength(2);
    const top = boxes.find((b) => b.rect.cy < 16)!;
    expect(top.rect.w).toBeGreaterThan(37);
    expect(top.rect.h).toBeGreaterThan(6);
    // 膨張した縁 (確率 0) も平均に入るので塗った値より下がる (RapidOCR と同じ)。
    expect(top.score).toBeGreaterThan(0.5);
  });

  it("treats tall boxes as vertical text and sizes the recognizer input", () => {
    const r = { cx: 0, cy: 0, w: 20, h: 100, angle: 0 };
    expect(isVertical(r)).toBe(true);
    expect(recWidth(r)).toBe(240);
    expect(recWidth({ ...r, w: 200, h: 24 })).toBe(400);
  });

  it("decodes CTC output: drops blanks and repeats", () => {
    const dict = ["a", "b"];
    // classes = blank + a + b + space
    const rows = [
      [0.1, 0.8, 0.05, 0.05],
      [0.1, 0.8, 0.05, 0.05],
      [0.9, 0.05, 0.03, 0.02],
      [0.1, 0.8, 0.05, 0.05],
      [0.1, 0.1, 0.1, 0.7],
      [0.1, 0.1, 0.7, 0.1],
    ];
    const { text, score } = ctcDecode(new Float32Array(rows.flat()), rows.length, 4, dict);
    expect(text).toBe("aa b");
    expect(score).toBeCloseTo(0.75, 3);
  });
});
