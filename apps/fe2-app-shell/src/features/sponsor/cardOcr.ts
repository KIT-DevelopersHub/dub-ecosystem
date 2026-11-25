// 名刺写真の文字読み取り (OCR)。PP-OCRv6 を端末内 (onnxruntime-web) で動かす = 写真を外部に送らない・$0。
// エンジン (ocr/engine.ts) は読み取る瞬間に動的 import する (一覧などほかの画面の読み込みを重くしない)。
import { parseCardLines, type CardDraft } from "./parseCardText.ts";

export interface OcrResult {
  text: string;
  draft: CardDraft;
}

/** progress = 0〜1 (モデルの取得 + 検出 + 認識)。signal で中断すると AbortError。 */
export async function readCard(image: Blob, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<OcrResult> {
  const { readLines } = await import("./ocr/engine.ts");
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const lines = await readLines(image, { onProgress, signal });
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  return { text: lines.map((l) => l.text).join("\n"), draft: parseCardLines(lines) };
}
