// Web-Crypto HMAC + constant-time comparison (works on Workers and Node20+).
// timingSafeEqual is used for every signature/token check (test #12).

const HEX = "0123456789abcdef";

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

/** HMAC-SHA256(secret, data) as lowercase hex. */
export async function hmacSha256Hex(secret: string, data: Uint8Array | string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  // copy into a fresh ArrayBuffer to satisfy BufferSource typing across DOM/worker libs
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const sig = await crypto.subtle.sign("HMAC", key, view);
  return toHex(sig);
}

/** Constant-time string comparison. Length mismatch returns false (hex is fixed-width). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

/** True if `candidateHex` matches any of the provided secrets' HMAC over `data`. */
export async function hmacMatchesAny(
  secrets: readonly (string | undefined)[],
  data: Uint8Array | string,
  candidateHex: string,
): Promise<boolean> {
  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = await hmacSha256Hex(secret, data);
    // do not short-circuit: compare all to keep timing uniform across the 2-secret set
    if (timingSafeEqual(expected, candidateHex)) matched = true;
  }
  return matched;
}
