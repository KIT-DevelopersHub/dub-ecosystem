// PP-OCRv6 (PaddleOCR) の前処理・後処理。RapidOCR (Python) の実装を移植したもの。
// ブラウザに依存しない純関数だけを置く (推論・画像の切り出しは engine.ts)。
//   検出 (DBNet): 画像を縮小 → 文字らしさの確率マップ → 2 値化 → 連結成分ごとに回転矩形 → 少し広げる
//   認識 (CRNN): 行ごとに高さ 48px へ切り出し → 文字ごとの確率 → CTC で文字列に

/** RGBA の画素。ImageData と同じ形。 */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 回転した矩形。w = 文字の並ぶ向きの長さ、angle = ラジアン (-π/4 〜 π/4)。 */
export interface RotRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

export const DET_LIMIT = 736;
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP_RATIO = 1.6;
const MIN_SIZE = 3;
const MAX_CANDIDATES = 1000;
export const REC_HEIGHT = 48;
// これより自信の低い行は捨てる (模様・写り込み)。RapidOCR の既定と同じ。
export const MIN_TEXT_SCORE = 0.5;

/** 検出に入れる大きさ: 長辺 DET_LIMIT 以下 (拡大はしない)・各辺 32 の倍数。 */
export function detSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.max(width, height) > DET_LIMIT ? DET_LIMIT / Math.max(width, height) : 1;
  const round32 = (n: number): number => Math.max(32, Math.round(Math.trunc(n * ratio) / 32) * 32);
  return { width: round32(width), height: round32(height) };
}

/**
 * 暗い・眠い写真の明るさを伸ばす: 明るさの下位 1% を黒、上位 1% を白に (色ごとではなく全体で)。
 * 暗い室内の写真で小さい行 (メール・電話) が検出から漏れるのを防ぐ。普通の写真ではほぼ変わらない。
 */
export function stretchContrast(px: Pixels): void {
  const { data } = px;
  const hist = new Uint32Array(256);
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) hist[Math.round((data[i]! + data[i + 1]! + data[i + 2]!) / 3)]!++;
  const at = (q: number): number => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v]!;
      if (acc >= n * q) return v;
    }
    return 255;
  };
  const lo = at(0.01);
  const hi = at(0.99);
  if (hi - lo < 1) return;
  const scale = 255 / (hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (data[i]! - lo) * scale;
    data[i + 1] = (data[i + 1]! - lo) * scale;
    data[i + 2] = (data[i + 2]! - lo) * scale;
  }
}

/** RGBA → モデル入力 (1×3×H×W・BGR の順・(x/255 − 0.5) / 0.5)。 */
export function toTensor(px: Pixels, out = new Float32Array(3 * px.width * px.height), offset = 0, rowWidth = px.width): Float32Array {
  const { data, width, height } = px;
  const plane = height * rowWidth;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = offset + y * rowWidth + x;
      out[o] = data[i + 2]! / 127.5 - 1;
      out[o + plane] = data[i + 1]! / 127.5 - 1;
      out[o + plane * 2] = data[i]! / 127.5 - 1;
    }
  }
  return out;
}

type Point = [number, number];

function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 点の集まりを囲む面積最小の矩形 (cv2.minAreaRect 相当)。角度は ±45° に揃え、w を横向きの長さにする。 */
export function minAreaRect(points: Point[]): RotRect {
  const hull = convexHull(points);
  if (hull.length === 1) return { cx: hull[0]![0], cy: hull[0]![1], w: 0, h: 0, angle: 0 };
  let best: RotRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const u = (minU + maxU) / 2;
      const v = (minV + maxV) / 2;
      best = { cx: u * cos - v * sin, cy: u * sin + v * cos, w: maxU - minU, h: maxV - minV, angle: theta };
    }
  }
  return normalizeAngle(best!);
}

function normalizeAngle(r: RotRect): RotRect {
  let { w, h, angle } = r;
  // 角度を (-π/2, π/2] に → さらに ±45° を超えるなら縦横を入れ替える。
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  if (angle > Math.PI / 4) {
    angle -= Math.PI / 2;
    [w, h] = [h, w];
  } else if (angle < -Math.PI / 4) {
    angle += Math.PI / 2;
    [w, h] = [h, w];
  }
  return { ...r, w, h, angle };
}

export function rectCorners(r: RotRect): Point[] {
  const cos = Math.cos(r.angle);
  const sin = Math.sin(r.angle);
  return [
    [-r.w / 2, -r.h / 2],
    [r.w / 2, -r.h / 2],
    [r.w / 2, r.h / 2],
    [-r.w / 2, r.h / 2],
  ].map(([u, v]) => [r.cx + u! * cos - v! * sin, r.cy + u! * sin + v! * cos]);
}

/** 矩形の中の確率の平均 (box_score_fast)。 */
function boxScore(prob: Float32Array, width: number, height: number, r: RotRect): number {
  const cs = rectCorners(r);
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[0]))));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...cs.map((c) => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[1]))));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...cs.map((c) => c[1]))));
  const cos = Math.cos(r.angle);
  const sin = Math.sin(r.angle);
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - r.cx;
      const dy = y - r.cy;
      if (Math.abs(dx * cos + dy * sin) <= r.w / 2 + 0.5 && Math.abs(-dx * sin + dy * cos) <= r.h / 2 + 0.5) {
        sum += prob[y * width + x]!;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * 確率マップ (検出の出力・width × height) → 文字の行の回転矩形 (検出の座標)。
 * 2 値化 → 2×2 で膨張 → 8 近傍の連結成分 → 最小外接矩形 → 平均確率で足切り → 広げる (unclip)。
 */
export function detBoxes(prob: Float32Array, width: number, height: number): { rect: RotRect; score: number }[] {
  const n = width * height;
  const mask = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // cv2.dilate (2×2・anchor は右下) = 自分・左・上・左上のどれかが閾値を超えていれば 1。
      const on = (xx: number, yy: number): boolean => xx >= 0 && yy >= 0 && prob[yy * width + xx]! > DET_THRESH;
      if (on(x, y) || on(x - 1, y) || on(x, y - 1) || on(x - 1, y - 1)) mask[y * width + x] = 1;
    }
  }
  const seen = new Uint8Array(n);
  const out: { rect: RotRect; score: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n && out.length < MAX_CANDIDATES; start++) {
    if (!mask[start] || seen[start]) continue;
    const pts: Point[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % width;
      const py = (p - px) / width;
      pts.push([px, py]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx;
          const qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
          const q = qy * width + qx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const rect = minAreaRect(pts);
    if (Math.min(rect.w, rect.h) < MIN_SIZE) continue;
    const score = boxScore(prob, width, height, rect);
    if (score < BOX_THRESH) continue;
    // unclip: 面積 × 比 / 周長 だけ外へ広げる (矩形なら各辺に同じ幅を足すのと同じ)。
    const d = (rect.w * rect.h * UNCLIP_RATIO) / (2 * (rect.w + rect.h));
    const grown = { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
    if (Math.min(grown.w, grown.h) < MIN_SIZE + 2) continue;
    out.push({ rect: grown, score });
  }
  return out;
}

/** 検出の座標 → 元画像の座標。 */
export function scaleRect(r: RotRect, sx: number, sy: number): RotRect {
  // 縦横で倍率が違うと角度もずれるので、角を写してから矩形を取り直す。
  if (Math.abs(sx - sy) < 1e-6) return { cx: r.cx * sx, cy: r.cy * sy, w: r.w * sx, h: r.h * sy, angle: r.angle };
  return minAreaRect(rectCorners(r).map(([x, y]) => [x * sx, y * sy]));
}

/** 縦書きの行 (高さが幅の 1.5 倍以上) は 90° 回して読む。 */
export const isVertical = (r: RotRect): boolean => r.h >= r.w * 1.5;

/** 認識に入れる幅 (高さ 48px に合わせた幅)。 */
export function recWidth(r: RotRect): number {
  const [len, thick] = isVertical(r) ? [r.h, r.w] : [r.w, r.h];
  return Math.max(REC_HEIGHT, Math.ceil((REC_HEIGHT * len) / Math.max(thick, 1)));
}

/**
 * CTC の貪欲デコード。probs = T × C (C = 1 + 辞書 + 空白)。0 = blank、連続する同じ文字は 1 つに。
 * score = 採った文字の確率の平均。
 */
export function ctcDecode(probs: Float32Array, steps: number, classes: number, dict: string[], offset = 0): { text: string; score: number } {
  let text = "";
  let sum = 0;
  let count = 0;
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestP = -Infinity;
    const base = offset + t * classes;
    for (let c = 0; c < classes; c++) {
      const p = probs[base + c]!;
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      text += dict[best - 1] ?? " ";
      sum += bestP;
      count++;
    }
    prev = best;
  }
  return { text, score: count > 0 ? sum / count : 0 };
}

/** 認識した行 (確信度つき)。 */
export interface ReadLine {
  text: string;
  score: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** 縦長の行 (縦書き・横向きの写真) が文字の量で占める割合。 */
export function verticalShare(rects: RotRect[]): number {
  let vertical = 0;
  let total = 0;
  for (const r of rects) {
    const len = Math.max(r.w, r.h);
    total += len;
    if (isVertical(r)) vertical += len;
  }
  return total > 0 ? vertical / total : 0;
}

/** どれだけよく読めたか: 確信度 × 文字数 の合計。向きの候補を比べるのに使う。 */
export const readingScore = (lines: ReadLine[]): number => lines.reduce((s, l) => s + l.score * l.text.length, 0);

/**
 * 縦書きの行の位置を「横書きに直した位置」に写す (右の列 → 上の行、列の上 → 行の左)。
 * 振り分けは横書きの並び (上から下・左から右) を前提にしているため。
 */
export function toHorizontalReading(lines: ReadLine[], width: number): ReadLine[] {
  return lines.map((l) => ({ ...l, bbox: { x0: l.bbox.y0, y0: width - l.bbox.x1, x1: l.bbox.y1, y1: width - l.bbox.x0 } }));
}

export const stripScores = (lines: ReadLine[]): { text: string; bbox: ReadLine["bbox"] }[] => lines.map(({ text, bbox }) => ({ text, bbox }));
