// Pasted / dropped images for the chat composer. Each image is shrunk in the browser to
// what Claude actually looks at (long edge <= 1568px; larger is downscaled by the API
// anyway) and re-encoded until its base64 fits ONE relay frame (the relay caps a request
// body at 256K chars), so a screenshot travels the same way locally and through the relay.

/** A ready-to-upload image plus a preview for the composer / message bubble. */
export interface ChatImage {
  id: string;
  name: string;
  mediaType: string;
  /** Base64 without the data: prefix. */
  data: string;
  /** data: URL for <img> previews (client-only; never persisted). */
  previewUrl: string;
}

export const MAX_IMAGES = 10;
/** Leaves headroom under the relay's 256K-char body cap for the JSON wrapper. */
export const MAX_ENCODED_CHARS = 240_000;
const MAX_EDGE = 1568;
const PASSTHROUGH = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];

let seq = 0;

/** Image files out of a paste / drop / file-input payload (non-images ignored). */
export function imageFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像を読み込めませんでした"));
    img.src = url;
  });
}

function split(dataUrl: string): { mediaType: string; data: string } {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  return m ? { mediaType: m[1]!, data: m[2]! } : { mediaType: "", data: "" };
}

/** Turn one image file into an upload-ready ChatImage. Throws with a Japanese message. */
export async function prepareImage(file: File): Promise<ChatImage> {
  const original = await readDataUrl(file);
  const img = await loadImage(original);
  const name = file.name || "pasted-image";
  const id = `img-${Date.now()}-${++seq}`;
  const fits = (s: { mediaType: string; data: string }) => PASSTHROUGH.has(s.mediaType) && s.data.length <= MAX_ENCODED_CHARS;

  const raw = split(original);
  if (fits(raw) && Math.max(img.naturalWidth, img.naturalHeight) <= MAX_EDGE) {
    return { id, name, ...raw, previewUrl: original };
  }

  let scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const canvas = document.createElement("canvas");
  for (let attempt = 0; attempt < 6; attempt++) {
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // PNG keeps screenshot text crisp; fall back to lossy formats only when it is too big.
    const encodings: [string, number?][] = [["image/png"], ...QUALITIES.flatMap((q): [string, number][] => [["image/webp", q], ["image/jpeg", q]])];
    for (const [type, q] of encodings) {
      const url = canvas.toDataURL(type, q);
      const s = split(url);
      if (fits(s)) return { id, name, ...s, previewUrl: url };
    }
    scale *= 0.75;
  }
  throw new Error("画像が大きすぎて送れません");
}
