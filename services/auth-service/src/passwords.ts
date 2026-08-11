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

// ---- reversible encryption for admin password viewing (#5c) ----------------
// The user has accepted (decision B) that an identity:admin may read a user's
// password. To avoid ever storing plaintext, the password is ALSO kept as an
// AES-256-GCM ciphertext under a server-held key (Worker secret PASSWORD_ENC_KEY,
// base64 of 32 bytes). LOGIN never decrypts — it verifies the PBKDF2 hash; only the
// admin view endpoint decrypts. Ciphertext is self-describing so the scheme can
// evolve: enc$v1$<ivB64url>$<cipherB64url>.
const ENC_VERSION = "v1";
const IV_BYTES = 12;

async function importEncKey(keyB64: string): Promise<CryptoKey> {
  // Accept standard- or url-base64 for the secret; decode to raw 32 bytes.
  const raw = fromBase64Url(keyB64.trim().replace(/\+/g, "-").replace(/\//g, "_"));
  if (raw.length !== 32) throw new Error("PASSWORD_ENC_KEY must decode to 32 bytes (AES-256)");
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a plaintext secret with AES-256-GCM under the server key (self-describing). */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await importEncKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, new TextEncoder().encode(plaintext)),
  );
  return `enc$${ENC_VERSION}$${toBase64Url(iv)}$${toBase64Url(ct)}`;
}

/** Decrypt a ciphertext produced by encryptSecret. Throws on a bad key / tamper. */
export async function decryptSecret(encoded: string, keyB64: string): Promise<string> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "enc" || parts[1] !== ENC_VERSION) throw new Error("malformed ciphertext");
  const key = await importEncKey(keyB64);
  const iv = fromBase64Url(parts[2]!);
  const ct = fromBase64Url(parts[3]!);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource);
  return new TextDecoder().decode(pt);
}

const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // no look-alikes
/** Cryptographically-random password for admin-issued initial/reset credentials. */
export function generatePassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += PW_ALPHABET[b % PW_ALPHABET.length];
  return out;
}

export interface StoredCredential {
  email: string; // normalized (lowercased) email
  hash: string; // encoded PBKDF2 form — never plaintext (login verification)
  enc?: string; // AES-GCM ciphertext of the plaintext (admin view #5c); absent = not viewable
  createdAt: string; // ISO-8601
  updatedAt?: string; // ISO-8601 of the last set/reset
  setBy?: string; // actor userId who set it (admin) or "self"; unset for seeded/demo creds
  mustChange?: boolean; // true when an admin issued an initial/reset password
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

export interface SetCredentialParams {
  email: string;
  password: string;
  encKey?: string; // when set, the plaintext is also stored AES-GCM-encrypted (admin view)
  setBy?: string; // actor userId (admin) or "self"
  mustChange?: boolean; // mark an admin-issued initial/reset password
  now?: () => string;
}

/** Set (or reset) a credential: a PBKDF2 hash for login PLUS, when an encryption key
 *  is provided, an AES-GCM copy of the plaintext for the admin view endpoint (#5c).
 *  createdAt is preserved across resets; updatedAt tracks the last change. */
export async function setCredential(store: PasswordStore, params: SetCredentialParams): Promise<void> {
  const now = params.now ?? (() => new Date().toISOString());
  const email = normalizeEmail(params.email);
  const existing = await store.get(email);
  const hash = await hashPassword(params.password);
  const enc = params.encKey ? await encryptSecret(params.password, params.encKey) : undefined;
  const cred: StoredCredential = {
    email,
    hash,
    ...(enc ? { enc } : {}),
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
    ...(params.setBy ? { setBy: params.setBy } : {}),
    ...(params.mustChange !== undefined ? { mustChange: params.mustChange } : {}),
  };
  await store.put(cred);
}

// Demo login credentials for the 3 company-domain accounts (admin / maintainer /
// member). These are the auth-service half of identity-roster's DEMO_USERS — the
// emails MUST match. Passwords are demo-only plaintext here but are ALWAYS stored
// as PBKDF2 hashes via seedDemoCredentials; they are never returned to a client.
// All emails are on the allowed company domain so the domain gate accepts them.
export const DEMO_CREDENTIALS: readonly { email: string; password: string }[] = [
  { email: "admin@developershub.jp", password: "demo-admin-pw" },
  { email: "maintainer@developershub.jp", password: "demo-maintainer-pw" },
  { email: "member@developershub.jp", password: "demo-member-pw" },
] as const;

/** Idempotent: seed every demo credential's PBKDF2 hash into the store. */
export async function seedDemoCredentials(store: PasswordStore, now: () => string = () => new Date().toISOString()): Promise<void> {
  for (const c of DEMO_CREDENTIALS) await seedPasswordCredential(store, c.email, c.password, now);
}
