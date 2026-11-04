// 名刺写真の端末側処理: カメラ映像の枠の範囲を切り出す / 選んだ写真を読む → 長辺 1600px の JPEG (品質 0.85)。
import { sponsor } from "@dub/types";

/** 名刺 (91mm × 55mm) の縦横比。撮影枠に使う。 */
export const CARD_ASPECT = 91 / 55;
export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.85;

export function cameraSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

function canvas2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx ? { canvas, ctx } : null;
}

/** source の (sx, sy, sw, sh) を長辺 MAX_EDGE 以下に縮めて JPEG にする。 */
export function drawToJpeg(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = canvas2d(w, h);
  if (!c) return Promise.reject(new Error("canvas unavailable"));
  c.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    c.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", JPEG_QUALITY),
  );
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * object-fit: cover で表示している映像 (videoW × videoH) のうち、画面上の枠 (frame・container 基準ではなく
 * どちらも画面座標) に写っている範囲を映像のピクセル座標で返す。
 */
export function coverCrop(videoW: number, videoH: number, container: Rect, frame: Rect): Rect {
  const scale = Math.max(container.width / videoW, container.height / videoH);
  const offX = (videoW * scale - container.width) / 2;
  const offY = (videoH * scale - container.height) / 2;
  const left = Math.max(0, (frame.left - container.left + offX) / scale);
  const top = Math.max(0, (frame.top - container.top + offY) / scale);
  return {
    left,
    top,
    width: Math.min(videoW - left, frame.width / scale),
    height: Math.min(videoH - top, frame.height / scale),
  };
}

export function captureFrame(video: HTMLVideoElement, container: Rect, frame: Rect): Promise<Blob> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return Promise.reject(new Error("video not ready"));
  const r = coverCrop(vw, vh, container, frame);
  return drawToJpeg(video, r.left, r.top, r.width, r.height);
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

export class CardImageError extends Error {}

/**
 * 選んだ写真 → 送れる JPEG。縮小できない環境 (canvas 無し) では、受け付ける形式・サイズならそのまま使う。
 */
export async function fileToCardImage(file: Blob): Promise<Blob> {
  const passThrough = (): Blob => {
    if (sponsor.isCardImageType(file.type) && file.size <= sponsor.CARD_IMAGE_MAX_BYTES) return file;
    throw new CardImageError("この写真は使えません。JPEG / PNG の写真を選ぶか、カメラで撮影してください。");
  };
  if (!canvas2d(1, 1)) return passThrough();
  try {
    const img = await loadImage(file);
    return await drawToJpeg(img, 0, 0, img.naturalWidth, img.naturalHeight);
  } catch {
    return passThrough();
  }
}
