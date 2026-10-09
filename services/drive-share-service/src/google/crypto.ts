// AES-GCM sealing for the Google refresh token at rest in D1. The key is the
// DRIVESHARE_TOKEN_ENC_KEY secret (base64 of 32 random bytes); a fresh 96-bit IV per
// seal. The org id is bound as additional data so a ciphertext copied to another org's
// row fails to open. Plaintext never leaves this module except to the token provider.

const AAD_PREFIX = "driveshare-google-refresh-token:";

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Import the base64 key secret. Returns null when absent or not exactly 256 bits, so
 *  a misconfigured key disables the connect flow instead of throwing per request. */
export async function importTokenKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null;
  let raw: Uint8Array;
  try {
    raw = fromB64(secret.trim());
  } catch {
    return null;
  }
  if (raw.byteLength !== 32) return null;
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  cipher: string;
  iv: string;
}

export async function sealToken(key: CryptoKey, orgId: string, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const additionalData = new TextEncoder().encode(AAD_PREFIX + orgId);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, data);
  return { cipher: toB64(new Uint8Array(cipher)), iv: toB64(iv) };
}

/** Throws on a wrong key / tampered row / other org's row (GCM auth failure). */
export async function openToken(key: CryptoKey, orgId: string, sealed: Sealed): Promise<string> {
  const additionalData = new TextEncoder().encode(AAD_PREFIX + orgId);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv), additionalData },
    key,
    fromB64(sealed.cipher),
  );
  return new TextDecoder().decode(plain);
}

/** Unguessable OAuth state (256 bits, base64url). */
export function newOAuthState(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
