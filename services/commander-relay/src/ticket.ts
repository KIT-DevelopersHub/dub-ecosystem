// Browser ws-ticket: a 60s HMAC-SHA256 token minted over the gateway (session + policy gate
// already checked) and verified by the CommanderRelay DO before it accepts a browser socket.
// Same shape as chat-service/src/wsticket.ts; scoped by `aud` so a chat ticket can never be
// replayed here even if the two secrets were ever set to the same value.

export const TICKET_TTL_SEC = 60;
const AUDIENCE = "commander-relay";

export interface TicketClaims {
  aud: typeof AUDIENCE;
  userId: string;
  expEpochMs: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

/** Constant-time compare for byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Constant-time compare for secrets given as strings. */
export function secretEquals(presented: string, expected: string): boolean {
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(presented), enc.encode(expected));
}

export async function signTicket(secret: string, userId: string, now: number = Date.now()): Promise<string> {
  const claims: TicketClaims = { aud: AUDIENCE, userId, expEpochMs: now + TICKET_TTL_SEC * 1000 };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${b64urlEncode(await hmac(secret, payload))}`;
}

/** Claims when the signature, audience and expiry all hold; otherwise null. */
export async function verifyTicket(secret: string, ticket: string, now: number = Date.now()): Promise<TicketClaims | null> {
  const dot = ticket.indexOf(".");
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  let got: Uint8Array;
  try {
    got = b64urlDecode(ticket.slice(dot + 1));
  } catch {
    return null;
  }
  if (!timingSafeEqual(await hmac(secret, payload), got)) return null;
  let claims: TicketClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as TicketClaims;
  } catch {
    return null;
  }
  if (claims.aud !== AUDIENCE || typeof claims.userId !== "string") return null;
  if (typeof claims.expEpochMs !== "number" || claims.expEpochMs < now) return null;
  return claims;
}
