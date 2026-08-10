// Cryptographic primitives: opaque session tokens. All randomness from WebCrypto
// (Workers runtime); no Node-only APIs. (CSRF state + PKCE were removed with web
// Google OAuth.)

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

/** Cheap format guard so verify() can classify obvious junk as "malformed". */
export function looksLikeToken(token: string): boolean {
  return token.length >= 32 && token.length <= 512 && BASE64URL.test(token);
}
