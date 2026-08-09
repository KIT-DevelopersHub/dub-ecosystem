// Client-generated idempotency key (Crockford ULID) for inquiry submissions.
// The frozen @dub/types PublicInquiryRequest body has no idempotencyKey field,
// so FE8 carries it as the `x-dub-idempotency-key` request header instead of the
// body (design §8 旧#8b intent: 受け側 dedupKey inquiry:<key>). Body stays contract-exact.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I/L/O/U)
const TIME_LEN = 10;
const RAND_LEN = 16;

function randomByte(): number {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const buf = new Uint8Array(1);
    g.crypto.getRandomValues(buf);
    return buf[0] as number;
  }
  return Math.floor(Math.random() * 256);
}

function encodeTime(now: number): string {
  let mod: number;
  let str = "";
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    mod = t % 32;
    str = (ENCODING[mod] as string) + str;
    t = (t - mod) / 32;
  }
  return str;
}

function encodeRandom(): string {
  let str = "";
  for (let i = 0; i < RAND_LEN; i++) {
    str += ENCODING[randomByte() % 32] as string;
  }
  return str;
}

/** Generate a 26-char uppercase Crockford ULID (lexicographically sortable). */
export function generateIdempotencyKey(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidUlid(value: string): boolean {
  return ULID_RE.test(value);
}
