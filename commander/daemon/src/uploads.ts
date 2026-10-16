// Staged image uploads for chat runs. The browser uploads each pasted image on its own
// (POST /uploads, one image per request so a relayed body stays under the relay's frame
// cap), gets an id back, then names those ids in POST /runs. Kept in memory only: an
// image lives until a run consumes it or the TTL drops it — never written to disk or D1.

import { randomUUID } from "node:crypto";

/** Media types the Claude API accepts as image content blocks. */
export const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Claude API per-image cap (decoded bytes). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Images one run may carry. */
export const MAX_IMAGES_PER_RUN = 10;
const MAX_STAGED = 50;
const TTL_MS = 30 * 60_000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface StagedImage {
  mediaType: string;
  /** Base64 (no data: prefix). */
  data: string;
}

interface Entry extends StagedImage {
  at: number;
}

export type StageResult = { ok: true; id: string } | { ok: false; error: string };

export class UploadStore {
  private entries = new Map<string, Entry>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  stage(mediaType: unknown, data: unknown): StageResult {
    if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(mediaType)) {
      return { ok: false, error: "unsupported_media_type" };
    }
    if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      return { ok: false, error: "invalid_image_data" };
    }
    if ((data.length / 4) * 3 > MAX_IMAGE_BYTES) return { ok: false, error: "image_too_large" };
    this.sweep();
    if (this.entries.size >= MAX_STAGED) {
      // Oldest first (Map keeps insertion order).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const id = randomUUID();
    this.entries.set(id, { mediaType, data, at: this.now() });
    return { ok: true, id };
  }

  /** Remove and return the images for `ids`; null when any id is unknown or expired. */
  take(ids: string[]): StagedImage[] | null {
    this.sweep();
    if (new Set(ids).size !== ids.length || !ids.every((id) => this.entries.has(id))) return null;
    return ids.map((id) => {
      const { mediaType, data } = this.entries.get(id)!;
      this.entries.delete(id);
      return { mediaType, data };
    });
  }

  size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [id, e] of this.entries) if (e.at < cutoff) this.entries.delete(id);
  }
}
