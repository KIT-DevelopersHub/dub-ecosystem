// ws-ticket: short-lived (60s) HMAC-SHA256 token the notification-owned InboxRoom DO
// verifies before accepting a realtime WebSocket. Mirrors chat-service/src/wsticket.ts
// (same construction), but the claim is scoped to a USER (not a channel): the inbox
// stream is per-user. This module is BOTH the issuer (HTTP side, GET /inbox/ws-ticket)
// and the reference verifier the DO imports, so both stay contract-exact.
//
// WHY a ticket at all (not the gateway): EventSource/WebSocket cannot send the fe5
// Authorization: Bearer header, and the api-gateway aborts any upstream stream at 15s.
// So the realtime path is DO-DIRECT (gateway-bypassing): the client opens
// wss://<notification worker>/ws/:userId?ticket=... and the DO is the sole gate.

// 60s — matches chat's ws-ticket TTL; the client re-fetches a fresh ticket per reconnect.
export const WS_TICKET_TTL_SEC = 60;

// Dev-only fallback secret used by BOTH the issuer (app.ts) and the verifier (the InboxRoom
// DO) when WS_TICKET_SECRET is unset, so `wrangler dev` works without a secret. It lives
// here (not in inbox-room-do.ts) so app.ts can import it WITHOUT pulling in the DO module's
// `cloudflare:workers` import — which is unresolvable in the vitest node test environment.
export const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";

export interface WsTicketClaims {
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
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

// Constant-time comparison to avoid signature-timing leaks.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** ticket = base64url(payloadJson) + "." + base64url(hmac(payloadJson)). */
export async function signWsTicket(secret: string, claims: WsTicketClaims): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = b64urlEncode(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

/** Verify signature + expiry. Returns claims when valid, else null (DO contract). */
export async function verifyWsTicket(
  secret: string,
  ticket: string,
  now: number = Date.now(),
): Promise<WsTicketClaims | null> {
  const dot = ticket.indexOf(".");
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  let expected: Uint8Array;
  let got: Uint8Array;
  try {
    expected = await hmac(secret, payload);
    got = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, got)) return null;
  let claims: WsTicketClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as WsTicketClaims;
  } catch {
    return null;
  }
  if (typeof claims.expEpochMs !== "number" || claims.expEpochMs < now) return null;
  if (typeof claims.userId !== "string" || claims.userId.length === 0) return null;
  return claims;
}

export function ticketExpiryMs(now: number = Date.now()): number {
  return now + WS_TICKET_TTL_SEC * 1000;
}
