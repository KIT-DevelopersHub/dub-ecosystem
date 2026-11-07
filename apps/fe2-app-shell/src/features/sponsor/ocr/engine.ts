// 名刺の文字読み取りエンジン: PP-OCRv6 (PaddleOCR) を onnxruntime-web で端末内実行する。写真は外部に送らない・$0。
// - モデル (検出 9.9MB + 認識 21MB) は初回だけ ModelScope の版を固定した URL から取得し、SHA-256 を照合して
//   Cache Storage に保存する (以後はオフラインでも読める)。
// - onnxruntime の wasm (約 15MB) はビルド時にアセットとして同梱され、アプリと同じ配信元から読む。
// - このファイルは読み取る瞬間に動的 import される (ほかの画面のバンドルは増えない)。
import type { CardLine } from "../parseCardText.ts";
import dictText from "./ppocrv6_dict.txt?raw";
import {
  ctcDecode,
  detBoxes,
  detSize,
  isVertical,
  MIN_TEXT_SCORE,
  recWidth,
  REC_HEIGHT,
  rectCorners,
  scaleRect,
  stretchContrast,
  toTensor,
  type Pixels,
  type RotRect,
} from "./paddle.ts";

const MODEL_BASE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6";
export const MODELS = {
  det: {
    url: `${MODEL_BASE}/det/PP-OCRv6_det_small.onnx`,
    sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    bytes: 9_929_594,
  },
  rec: {
    url: `${MODEL_BASE}/rec/PP-OCRv6_rec_small.onnx`,
    sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    bytes: 21_234_383,
  },
} as const;
const CACHE_NAME = "sponsor-card-ocr-v1";
const REC_BATCH = 6;

type Ort = typeof import("onnxruntime-web/wasm");
type Session = import("onnxruntime-web/wasm").InferenceSession;

export class OcrModelError extends Error {}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** モデルを取得する。キャッシュがあればそれを、無ければ取得して照合後に保存。onBytes = 受信したバイト数。 */
async function loadModel(m: (typeof MODELS)[keyof typeof MODELS], onBytes: (n: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const cache = typeof caches !== "undefined" ? await caches.open(CACHE_NAME).catch(() => null) : null;
  const hit = await cache?.match(m.url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    onBytes(buf.byteLength);
    return buf;
  }
  const res = await fetch(m.url, { signal });
  if (!res.ok || !res.body) throw new OcrModelError(`model fetch failed: ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes(received);
  }
  const buf = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  // 版を固定した URL でも中身が差し替わっていないことを確かめる。
  if ((await sha256Hex(buf.buffer)) !== m.sha256) throw new OcrModelError("model checksum mismatch");
  await cache?.put(m.url, new Response(buf, { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
  return buf.buffer;
}

interface Engine {
  ort: Ort;
  det: Session;
  rec: Session;
  dict: string[];
}

// 一度作ったセッションは使い回す (2 枚目以降はモデルの読み込みが要らない)。失敗したら作り直せるよう捨てる。
let enginePromise: Promise<Engine> | null = null;

function getEngine(onProgress: (p: number) => void, signal?: AbortSignal): Promise<Engine> {
  enginePromise ??= (async () => {
    const ort = await import("onnxruntime-web/wasm");
    // 推論を別スレッド (Worker) で動かし、読み取り中も画面が固まらないようにする。
    ort.env.wasm.proxy = true;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const total = MODELS.det.bytes + MODELS.rec.bytes;
    let detBytes = 0;
    let recBytes = 0;
    const report = () => onProgress(Math.min(1, (detBytes + recBytes) / total));
    const [detBuf, recBuf] = await Promise.all([
      loadModel(MODELS.det, (n) => ((detBytes = n), report()), signal),
      loadModel(MODELS.rec, (n) => ((recBytes = n), report()), signal),
    ]);
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" } as const;
    const det = await ort.InferenceSession.create(new Uint8Array(detBuf), opts);
    const rec = await ort.InferenceSession.create(new Uint8Array(recBuf), opts);
    return { ort, det, rec, dict: dictText.split("\n") };
  })();
  enginePromise.catch(() => {
    enginePromise = null;
  });
  return enginePromise;
}

function canvas(width: number, height: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas unavailable");
  return { c, ctx };
}

/** 回転矩形の範囲を、文字の高さ REC_HEIGHT の水平な画像として切り出す (縦書きは 90° 回す)。 */
function cropLine(src: HTMLCanvasElement, r: RotRect, width: number): Pixels {
  const { ctx } = canvas(width, REC_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, REC_HEIGHT);
  ctx.imageSmoothingQuality = "high";
  ctx.translate(width / 2, REC_HEIGHT / 2);
  if (isVertical(r)) {
    // np.rot90 (反時計回り) と同じ向き。
    ctx.rotate(-Math.PI / 2);
    ctx.scale(REC_HEIGHT / Math.max(r.w, 1), REC_HEIGHT / Math.max(r.w, 1));
  } else {
    ctx.scale(REC_HEIGHT / Math.max(r.h, 1), REC_HEIGHT / Math.max(r.h, 1));
  }
  ctx.rotate(-r.angle);
  ctx.translate(-r.cx, -r.cy);
  ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, width, REC_HEIGHT);
}

export interface ReadOptions {
  /** 0〜1。モデルの取得 → 検出 → 認識。 */
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

/** 写真 → 位置つきの行。 */
export async function readLines(image: Blob, { onProgress, signal }: ReadOptions = {}): Promise<CardLine[]> {
  const live = () => {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  };
  const engine = await getEngine((p) => onProgress?.(p * 0.6), signal);
  live();
  onProgress?.(0.6);
  const { ort, det, rec, dict } = engine;

  const bitmap = await createImageBitmap(image);
  const src = canvas(bitmap.width, bitmap.height);
  src.ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const full = src.ctx.getImageData(0, 0, src.c.width, src.c.height);
  stretchContrast(full);
  src.ctx.putImageData(full, 0, 0);

  // 検出
  const size = detSize(src.c.width, src.c.height);
  const small = canvas(size.width, size.height);
  small.ctx.imageSmoothingQuality = "high";
  small.ctx.drawImage(src.c, 0, 0, size.width, size.height);
  const detIn = new ort.Tensor("float32", toTensor(small.ctx.getImageData(0, 0, size.width, size.height)), [1, 3, size.height, size.width]);
  const detOut = await det.run({ [det.inputNames[0]!]: detIn });
  live();
  onProgress?.(0.7);
  const prob = detOut[det.outputNames[0]!]!.data as Float32Array;
  const rects = detBoxes(prob, size.width, size.height).map((b) => scaleRect(b.rect, src.c.width / size.width, src.c.height / size.height));

  // 認識: 幅の近い行をまとめて 1 回の推論にする。
  const items = rects.map((r) => ({ r, width: recWidth(r) })).sort((a, b) => a.width - b.width);
  const lines: CardLine[] = [];
  for (let i = 0; i < items.length; i += REC_BATCH) {
    live();
    const batch = items.slice(i, i + REC_BATCH);
    const width = batch[batch.length - 1]!.width;
    const plane = REC_HEIGHT * width;
    const input = new Float32Array(batch.length * 3 * plane);
    batch.forEach((it, j) => toTensor(cropLine(src.c, it.r, it.width), input, j * 3 * plane, width));
    const out = await rec.run({ [rec.inputNames[0]!]: new ort.Tensor("float32", input, [batch.length, 3, REC_HEIGHT, width]) });
    const t = out[rec.outputNames[0]!]!;
    const [, steps, classes] = t.dims as [number, number, number];
    const data = t.data as Float32Array;
    batch.forEach((it, j) => {
      const { text, score } = ctcDecode(data, steps, classes, dict, j * steps * classes);
      if (!text.trim() || score < MIN_TEXT_SCORE) return;
      const cs = rectCorners(it.r);
      const xs = cs.map((c) => c[0]);
      const ys = cs.map((c) => c[1]);
      lines.push({ text, bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } });
    });
    onProgress?.(0.7 + (0.3 * Math.min(items.length, i + REC_BATCH)) / Math.max(items.length, 1));
  }
  return lines;
}
