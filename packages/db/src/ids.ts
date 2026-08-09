// Schema convention utilities: prefix-ULID id mint and canonical timestamp.
// newId(prefix) is the ONLY id mint in the codebase (D1).

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

type RandomSource = { getRandomValues?: (a: Uint8Array) => Uint8Array };
function randomByte(): number {
  const g = (globalThis as { crypto?: RandomSource }).crypto;
  if (g && typeof g.getRandomValues === "function") {
    const buf = new Uint8Array(1);
    g.getRandomValues(buf);
    return buf[0] as number;
  }
  return Math.floor(Math.random() * 256);
}

function encodeTime(now: number): string {
  let out = "";
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN;
    out = ENCODING[mod]! + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[randomByte() % ENCODING_LEN]!;
  }
  return out;
}

/** Generate a monotonic-ish ULID (lexicographically time-ordered). */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** newId("task") -> "task_01J...". Prefix must be lowercase snake. */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/** Canonical UTC ISO8601 timestamp; the only timestamp mint (D2, DDL DEFAULT banned). */
export function nowIso(): string {
  return new Date().toISOString();
}
