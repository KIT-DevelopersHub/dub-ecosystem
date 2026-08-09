// Minimal monotonic, lexicographically-sortable id (ULID-shaped) for the mock
// server and optimistic clientTempIds. Not cryptographic — dev/test only; real
// ULIDs are minted server-side (common.newId). Kept dependency-free.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = 0;
let lastRand: number[] = [];

function randChars(len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(Math.floor(Math.random() * 32));
  return out;
}

function encodeTime(time: number): string {
  let t = time;
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Monotonic ULID: strictly increasing even within the same millisecond. */
export function newUlid(prefix = ""): string {
  const now = Date.now();
  if (now === lastTime) {
    // increment the random component so ordering stays strict within a ms
    for (let i = RAND_LEN - 1; i >= 0; i--) {
      if (lastRand[i]! < 31) {
        lastRand[i]!++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastTime = now;
    lastRand = randChars(RAND_LEN);
  }
  const rand = lastRand.map((n) => ENCODING[n]).join("");
  return `${prefix}${encodeTime(now)}${rand}`;
}

export const newMessageId = (): string => newUlid("msg_");
export const newChannelId = (): string => newUlid("chn_");
export const newClientTempId = (): string => newUlid("tmp_");
