// 名刺写真の文字読み取り (OCR)。Tesseract.js を端末内 (ブラウザの Web Worker) で動かす = 写真を外部に送らない・$0。
// エンジンと日本語/英語の学習データは初回だけ CDN から取得し、以後はブラウザにキャッシュされる。
// ライブラリは使う瞬間に動的 import する (一覧などほかの画面の読み込みを重くしない)。
import type { Block } from "tesseract.js";
import { parseCardLines, sameRow, type CardBox, type CardDraft, type CardLine } from "./parseCardText.ts";

export interface OcrResult {
  text: string;
  draft: CardDraft;
}

/** Tesseract のレイアウト結果 → 位置つきの行。 */
export function blocksToLines(blocks: Block[] | null): CardLine[] {
  return (blocks ?? [])
    .flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
    .map((l) => ({ text: l.text, bbox: l.bbox }));
}

// Tesseract が読みやすい文字の高さ。これより大きく写った行 (氏名・社名) は縮めて読み直す。
export const REREAD_HEIGHT = 40;
const REREAD_MIN = REREAD_HEIGHT * 1.5;

export interface Row {
  box: CardBox;
  /** まとめた行の位置 (lines の添字)。 */
  members: number[];
}

const height = (b: CardBox): number => b.y1 - b.y0;

/**
 * 大きい文字の行を、同じ高さに並ぶ断片ごとにまとめる (「宇野」「正樹」・1 文字ずつ割れた氏名)。
 * 高さが 1.5 倍以上違う行はつながない (左の社名と右の部署を 1 行にしない)。
 */
export function largeRows(lines: CardLine[]): Row[] {
  const rows: Row[] = [];
  lines.forEach((l, i) => {
    if (!l.bbox || height(l.bbox) < REREAD_MIN) return;
    const b = l.bbox;
    const row = rows.find((r) => sameRow(r.box, b) && Math.max(height(r.box), height(b)) / Math.min(height(r.box), height(b)) < 1.5);
    if (!row) {
      rows.push({ box: { ...b }, members: [i] });
      return;
    }
    row.members.push(i);
    row.box = { x0: Math.min(row.box.x0, b.x0), y0: Math.min(row.box.y0, b.y0), x1: Math.max(row.box.x1, b.x1), y1: Math.max(row.box.y1, b.y1) };
  });
  return rows;
}

/** 読み直した行で元の断片を置き換える。読み直しが空なら元のまま。 */
export function replaceRows(lines: CardLine[], rows: Row[], texts: string[]): CardLine[] {
  const replaced = new Set<number>();
  const added: CardLine[] = [];
  rows.forEach((r, i) => {
    const text = texts[i]?.trim();
    if (!text) return;
    r.members.forEach((m) => replaced.add(m));
    added.push({ text, bbox: r.box });
  });
  return [...lines.filter((_, i) => !replaced.has(i)), ...added];
}

/** 行の範囲 (上下左右に余白) を切り出し、文字の高さが REREAD_HEIGHT になるよう縮める。 */
function cropRow(bitmap: ImageBitmap, box: CardBox): HTMLCanvasElement {
  const h = height(box);
  const pad = Math.round(h * 0.25);
  const sx = Math.max(0, box.x0 - pad);
  const sy = Math.max(0, box.y0 - pad);
  const sw = Math.min(bitmap.width - sx, box.x1 - box.x0 + pad * 2);
  const sh = Math.min(bitmap.height - sy, h + pad * 2);
  const scale = REREAD_HEIGHT / h;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * progress = 0〜1 (学習データの取得 + 認識)。signal で中断すると Worker を止めて AbortError。
 *
 * 1. 日本語 + 英語モデルで全体を読む (位置つきの行)。
 * 2. 大きく写った行 (氏名・社名) だけ縮めて 1 行として読み直す。Tesseract は大きすぎる文字で誤読・脱落が増える
 *    (スマホで名刺を画面いっぱいに撮ると氏名は 100px を超える)。
 * 3. 英語モデルだけで全体を読み、メール・電話に使う (日本語モデルは小さい数字と英字を読み違える: 5→3、.co.jp→.cojp)。
 * 学習データは 1 で読み込み済みなので追加のダウンロードは無い。2・3 が失敗しても 1 の結果で続ける。
 */
export async function readCard(image: Blob, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<OcrResult> {
  const { createWorker, PSM } = await import("tesseract.js");
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  // 学習データの読み込み → 1 → 2 → 3 を 1 本の進捗にする。
  let phase: "first" | "reread" | "latin" = "first";
  const worker = await createWorker(["jpn", "eng"], undefined, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        if (phase === "first") onProgress?.(0.5 + m.progress * 0.3);
        else if (phase === "latin") onProgress?.(0.85 + m.progress * 0.15);
      } else if (m.status.startsWith("loading") && phase === "first") onProgress?.(m.progress / 2);
    },
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void worker.terminate().catch(() => undefined);
  };
  const assertLive = () => {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    assertLive();
    // 名刺は文字の大きさがばらばらで段組みも自由。散在モードだと小さい役職の行も落とさず、左右のカラムも分かれる。
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    assertLive();
    let lines = blocksToLines(data.blocks);

    phase = "reread";
    onProgress?.(0.8);
    const rows = largeRows(lines);
    if (rows.length > 0) {
      try {
        const bitmap = await createImageBitmap(image);
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
        const texts: string[] = [];
        for (const r of rows) {
          assertLive();
          texts.push((await worker.recognize(cropRow(bitmap, r.box))).data.text);
        }
        bitmap.close();
        lines = replaceRows(lines, rows, texts);
      } catch (e) {
        assertLive();
        console.warn("card ocr: reread failed", e);
      }
    }

    phase = "latin";
    onProgress?.(0.85);
    let latinText = "";
    try {
      await worker.reinitialize("eng");
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      latinText = (await worker.recognize(image)).data.text;
    } catch (e) {
      // 中断以外の失敗なら 1 回目の結果だけで続ける。
      assertLive();
      console.warn("card ocr: latin pass failed", e);
    }
    assertLive();
    return { text: data.text, draft: parseCardLines(lines, latinText) };
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
