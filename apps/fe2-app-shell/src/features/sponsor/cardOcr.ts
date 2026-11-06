// 名刺写真の文字読み取り (OCR)。Tesseract.js を端末内 (ブラウザの Web Worker) で動かす = 写真を外部に送らない・$0。
// エンジンと日本語/英語の学習データは初回だけ CDN から取得し、以後はブラウザにキャッシュされる。
// ライブラリは使う瞬間に動的 import する (一覧などほかの画面の読み込みを重くしない)。
import type { Block } from "tesseract.js";
import { parseCardLines, type CardDraft, type CardLine } from "./parseCardText.ts";

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

/**
 * progress = 0〜1 (学習データの取得 + 認識)。signal で中断すると Worker を止めて AbortError。
 *
 * 2 回読む: 日本語 + 英語モデルは会社名・氏名に強いが、小さい数字と英字を読み違える (5→3、.co.jp→.cojp)。
 * 英語モデルだけの結果をメール・電話に使う。学習データは 1 回目で読み込み済みなので追加のダウンロードは無い。
 */
export async function readCard(image: Blob, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<OcrResult> {
  const { createWorker, PSM } = await import("tesseract.js");
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let latinPass = false;
  const worker = await createWorker(["jpn", "eng"], undefined, {
    logger: (m) => {
      // 学習データの読み込み → 日本語の認識 → 英語の認識 を 1 本の進捗にする。
      if (m.status === "recognizing text") onProgress?.(latinPass ? 0.85 + m.progress * 0.15 : 0.5 + m.progress * 0.35);
      else if (m.status.startsWith("loading") && !latinPass) onProgress?.(m.progress / 2);
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
    const lines = blocksToLines(data.blocks);

    latinPass = true;
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
