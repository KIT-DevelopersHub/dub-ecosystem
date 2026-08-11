// Byte-unit constants. Storage ceilings are stored in BYTES internally (so pct math is
// exact against Cloudflare's byte-valued payloadSize) while the dashboard `unit` says "GB".

/** 1 GiB in bytes (2^30). Cloudflare reports storage in bytes. */
export const GIB = 1024 * 1024 * 1024;

/** Nominal 1 GB label unit — the display unit only; math uses GIB bytes. */
export type GB = number;

/** Convert bytes to GB (decimal, 2dp) for display. */
export function bytesToGb(bytes: number): number {
  return Math.round((bytes / GIB) * 100) / 100;
}
