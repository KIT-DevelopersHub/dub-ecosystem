// Email+password credential auth — an additive path alongside Google OAuth so the
// ecosystem can be driven with self-owned accounts (no Google propagation needed).
// Passwords are NEVER stored or logged in plaintext: PBKDF2-SHA256 with a random
// per-credential salt (WebCrypto — Workers-safe, no Node APIs). The encoded form is
// self-describing so the KDF params can evolve without a data migration:
//   pbkdf2$sha256$<iterations>$<saltB64url>$<hashB64url>
import type { KVNamespace } from "@cloudflare/workers-types";

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const CRED_PREFIX = "pwcred:";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    keyMaterial,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a plaintext password into the self-describing encoded form (safe to store). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Constant-time byte compare (independent of where the first mismatch is). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Verify a plaintext password against a stored encoded hash. Never throws. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
    const iterations = Number.parseInt(parts[2]!, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const salt = fromBase64Url(parts[3]!);
    const expected = fromBase64Url(parts[4]!);
    const actual = await pbkdf2(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface StoredCredential {
  email: string; // normalized (lowercased) email
  hash: string; // encoded PBKDF2 form — never plaintext
  createdAt: string; // ISO-8601
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** KV-backed store of email→credential. Passwords live only as encoded hashes. */
export interface PasswordStore {
  get(email: string): Promise<StoredCredential | null>;
  put(cred: StoredCredential): Promise<void>;
}

export class KvPasswordStore implements PasswordStore {
  constructor(private readonly kv: KVNamespace) {}
  async get(email: string): Promise<StoredCredential | null> {
    const raw = await this.kv.get(CRED_PREFIX + normalizeEmail(email));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredCredential;
    } catch {
      return null;
    }
  }
  async put(cred: StoredCredential): Promise<void> {
    await this.kv.put(CRED_PREFIX + normalizeEmail(cred.email), JSON.stringify(cred));
  }
}

/** Seed (or reset) a demo credential. Plaintext is hashed here and discarded. */
export async function seedPasswordCredential(store: PasswordStore, email: string, password: string, now: () => string = () => new Date().toISOString()): Promise<void> {
  const normalized = normalizeEmail(email);
  const hash = await hashPassword(password);
  await store.put({ email: normalized, hash, createdAt: now() });
}
