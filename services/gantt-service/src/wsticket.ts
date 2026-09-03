// ws-ticket: short-lived (60s) HMAC-SHA256 token the gantt-owned GanttRoom DO verifies
// before accepting a WS connection (gateway-bypassing / DO-direct; gantt self-owned
// secret). This module is BOTH the issuer (HTTP side) and the reference verifier (the DO
// imports the same verify to stay contract-exact).写経 of chat-service/src/wsticket.ts,
// keyed by eventId instead of channelId.
import type { common } from "@dub/types";

/** ws-ticket lifetime. Just long enough for the browser to open the WS after the GET. */
export const WS_TICKET_TTL_SEC = 60;

export interface WsTicketClaims {
  eventId: common.EventId;
  userId: common.UserId;
  expEpochMs: number;
  /** Optional signed display label. The prod issuer omits it (identity is a bare userId
   *  there; the client resolves names from its roster); the dev/demo issuer sets it so the
   *  self-contained demo can show human names without a roster. Non-spoofable (signed). */
  displayName?: string;
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
  if (typeof claims.eventId !== "string" || typeof claims.userId !== "string") return null;
  return claims;
}

export function ticketExpiryMs(now: number = Date.now()): number {
  return now + WS_TICKET_TTL_SEC * 1000;
}

/** Absolute DO-direct URL for an event's room. `:id` in the base is replaced with the
 *  event id; a base without `:id` gets `/<eventId>` appended. */
export function buildDoUrl(base: string, eventId: common.EventId): string {
  return base.includes(":id")
    ? base.replace(":id", encodeURIComponent(eventId))
    : `${base}/${encodeURIComponent(eventId)}`;
}
