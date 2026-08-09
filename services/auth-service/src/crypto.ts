// Cryptographic primitives: opaque session tokens, CSRF state, PKCE (S256).
// All randomness from WebCrypto (Workers runtime); no Node-only APIs.

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

/** 256-bit opaque session token, base64url (used as KV key suffix). */
export function newSessionToken(): string {
  return toBase64Url(randomBytes(32));
}

/** CSRF state value stored in oauth_state:<state>. */
export function newState(): string {
  return toBase64Url(randomBytes(24));
}

/** Cheap format guard so verify() can classify obvious junk as "malformed". */
export function looksLikeToken(token: string): boolean {
  return token.length >= 32 && token.length <= 512 && BASE64URL.test(token);
}

export interface PkcePair {
  verifier: string; // stored server-side (web) in oauth_state
  challenge: string; // sent to Google
  method: "S256";
}

/** Server-side PKCE for the web flow (mobile does PKCE client-side). */
export async function newPkce(): Promise<PkcePair> {
  const verifier = toBase64Url(randomBytes(48));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)), method: "S256" };
}
