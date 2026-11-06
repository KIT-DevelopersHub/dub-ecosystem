// 名刺写真の文字読み取り (OCR)。Tesseract.js を端末内 (ブラウザの Web Worker) で動かす = 写真を外部に送らない・$0。
// エンジンと日本語/英語の学習データは初回だけ CDN から取得し、以後はブラウザにキャッシュされる。
// ライブラリは使う瞬間に動的 import する (一覧などほかの画面の読み込みを重くしない)。
import { parseCardText, type CardDraft } from "./parseCardText.ts";

export interface OcrResult {
  text: string;
  draft: CardDraft;
}

/** progress = 0〜1 (学習データの取得 + 認識)。signal で中断すると Worker を止めて AbortError。 */
export async function readCard(image: Blob, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<OcrResult> {
  const { createWorker, PSM } = await import("tesseract.js");
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const worker = await createWorker(["jpn", "eng"], undefined, {
    logger: (m) => {
      // 学習データの読み込みを前半、認識を後半として 1 本の進捗にする。
      if (m.status === "recognizing text") onProgress?.(0.5 + m.progress / 2);
      else if (m.status.startsWith("loading")) onProgress?.(m.progress / 2);
    },
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void worker.terminate().catch(() => undefined);
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    // 既定の「1 ブロック」だと文字の大きさが混ざる名刺で大きい氏名を落とす。レイアウトを自動解析させる。
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data } = await worker.recognize(image);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return { text: data.text, draft: parseCardText(data.text) };
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
