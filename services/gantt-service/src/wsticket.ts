// ws-ticket: short-lived (GANTT_WS_TICKET_TTL_SEC) HMAC-SHA256 token the gantt-owned
// GanttRoom DO verifies before accepting a WS connection. gateway-bypassing / DO-direct
// (theme11, mirrors chat-service): this module is BOTH the issuer (HTTP side) and the
// reference verifier (the DO imports the same verify to stay contract-exact).
//
// The claims carry the gantt room key (eventId) + the caller's identity (userId, and a
// best-effort displayName label). Because the ticket is signed, the DO can trust the
// userId/displayName it recovers — the browser never gets to assert its own identity on
// the /ws path (which is public, so header trust is unavailable there).
import { gantt } from "@dub/types";
import type { common } from "@dub/types";

export interface WsTicketClaims {
  eventId: common.EventId;
  userId: common.UserId;
  /** Non-spoofable display label (signed). Optional: absent when unresolved. */
  displayName?: string;
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
  if (typeof claims.eventId !== "string" || typeof claims.userId !== "string") return null;
  return claims;
}

export function ticketExpiryMs(now: number = Date.now()): number {
  return now + gantt.GANTT_WS_TICKET_TTL_SEC * 1000;
}
