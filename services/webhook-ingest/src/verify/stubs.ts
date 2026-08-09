// Source verifiers for google-drive / gmail / stripe. google-drive & stripe are enabled;
// gmail's OIDC verifier is implemented here but its endpoint stays gated (see 9-B).
// The "偽物を通さない" property is unit-tested for every source (tests #4/#5 + gmail).
import { hmacMatchesAny, timingSafeEqual } from "../crypto";
import { STRIPE_TOLERANCE_SEC } from "../env";
import type { Verifier } from "./types";

// ---- google-drive: X-Goog-Channel-Token must match drive-proxy issued token ----
export const verifyGoogleDrive: Verifier = async (input, secrets) => {
  const channelId = input.headers.get("x-goog-channel-id");
  const messageNumber = input.headers.get("x-goog-message-number");
  const token = input.headers.get("x-goog-channel-token");
  const resourceState = input.headers.get("x-goog-resource-state") ?? "change";

  if (!channelId || !messageNumber) return { ok: false, reason: "missing channel headers" };
  const pool = secrets.driveTokens ?? [];
  if (pool.every((t) => !t)) return { ok: false, reason: "no drive token configured" };
  if (!token) return { ok: false, reason: "missing channel token" };

  const matched = pool.some((t) => (t ? timingSafeEqual(t, token) : false));
  if (!matched) return { ok: false, reason: "channel token mismatch" };

  return { ok: true, externalId: `${channelId}:${messageNumber}`, eventKind: resourceState };
};

// ---- stripe: Stripe-Signature "t=..,v1=.." HMAC + replay window (test #4) ----
export const verifyStripe: Verifier = async (input, secrets) => {
  const header = input.headers.get("stripe-signature");
  if (!header) return { ok: false, reason: "missing Stripe-Signature" };

  let timestamp: number | null = null;
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) timestamp = Number.parseInt(v, 10);
    else if (k === "v1" && v) v1s.push(v.toLowerCase());
  }
  if (timestamp === null || Number.isNaN(timestamp) || v1s.length === 0) {
    return { ok: false, reason: "malformed Stripe-Signature" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > STRIPE_TOLERANCE_SEC) {
    return { ok: false, reason: "timestamp outside tolerance window" };
  }

  const pool = secrets.stripe ?? [];
  if (pool.every((s) => !s)) return { ok: false, reason: "no stripe secret configured" };

  const signedPayload = `${timestamp}.${new TextDecoder().decode(input.rawBytes)}`;
  let matched = false;
  for (const candidate of v1s) {
    if (await hmacMatchesAny(pool, signedPayload, candidate)) matched = true;
  }
  if (!matched) return { ok: false, reason: "signature mismatch" };

  // event id lives in the body; extract best-effort for the dedup key
  let externalId = "";
  try {
    const parsed = JSON.parse(new TextDecoder().decode(input.rawBytes)) as { id?: unknown; type?: unknown };
    if (typeof parsed.id === "string") externalId = parsed.id;
    const kind = typeof parsed.type === "string" ? parsed.type : "event";
    if (!externalId) return { ok: false, reason: "missing event id" };
    return { ok: true, externalId, eventKind: kind };
  } catch {
    return { ok: false, reason: "body not JSON" };
  }
};

// ---- gmail: Google Pub/Sub push OIDC (JWKS + RS256 JWT: sig / iss / aud / exp + SA id) --
// Gmail push arrives as an authenticated Pub/Sub push: an `Authorization: Bearer <jwt>`
// header carrying a Google-signed OIDC token, and a body that is the Pub/Sub envelope
// ({ message: { messageId, ... }, subscription }). We authenticate the token; the
// message id is the source-native dedup key. The verifier never interprets Gmail payload.
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

export interface GmailVerifierDeps {
  /** Injectable fetch for JWKS retrieval (tests supply a fake); defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable clock in epoch ms (tests freeze it); defaults to Date.now. */
  now?: () => number;
  /** Override the JWKS endpoint (tests point it at a fake). */
  jwksUri?: string;
  /** exp/iat skew allowance in seconds. */
  clockToleranceSec?: number;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}
interface OidcClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  email?: string;
  email_verified?: boolean;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson<T>(s: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
  } catch {
    return null;
  }
}

async function verifyRs256(
  signingInput: string,
  signatureB64url: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = b64urlToBytes(signatureB64url);
  const data = new TextEncoder().encode(signingInput);
  // fresh copies to satisfy BufferSource typing across DOM/worker libs
  const sigBuf = new Uint8Array(sig.byteLength);
  sigBuf.set(sig);
  const dataBuf = new Uint8Array(data.byteLength);
  dataBuf.set(data);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBuf, dataBuf);
}

export function createGmailVerifier(deps: GmailVerifierDeps = {}): Verifier {
  const jwksUri = deps.jwksUri ?? GOOGLE_JWKS_URI;
  const tolerance = deps.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;

  return async (input, secrets) => {
    const audience = secrets.gmailAudience;
    if (!audience) return { ok: false, reason: "no gmail audience configured" };
    // aud is chosen by whoever creates the push subscription and is therefore
    // attacker-controllable; the SA identity (email + email_verified) must be pinned too.
    const expectedEmail = secrets.gmailServiceAccountEmail;
    if (!expectedEmail) return { ok: false, reason: "no gmail service account configured" };

    const authz = input.headers.get("authorization");
    if (!authz || !/^Bearer\s+/i.test(authz)) {
      return { ok: false, reason: "missing bearer token" };
    }
    const token = authz.replace(/^Bearer\s+/i, "").trim();
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed jwt" };
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    const header = b64urlToJson<JwtHeader>(headerB64);
    if (!header || header.alg !== "RS256" || !header.kid) {
      return { ok: false, reason: "unsupported jwt header" };
    }

    // fetch the current Google signing keys and pick the one this token names
    let jwk: (JsonWebKey & { kid?: string }) | undefined;
    try {
      const doFetch = deps.fetch ?? fetch;
      const res = await doFetch(jwksUri);
      if (!res.ok) return { ok: false, reason: `jwks fetch failed (${res.status})` };
      const jwks = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
      jwk = jwks.keys?.find((k) => k.kid === header.kid);
    } catch {
      return { ok: false, reason: "jwks fetch error" };
    }
    if (!jwk) return { ok: false, reason: "signing key not found" };

    let validSig = false;
    try {
      validSig = await verifyRs256(`${headerB64}.${payloadB64}`, sigB64, jwk);
    } catch {
      return { ok: false, reason: "signature verification error" };
    }
    if (!validSig) return { ok: false, reason: "signature mismatch" };

    const claims = b64urlToJson<OidcClaims>(payloadB64);
    if (!claims) return { ok: false, reason: "malformed claims" };
    if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) {
      return { ok: false, reason: "issuer mismatch" };
    }
    if (claims.aud !== audience) return { ok: false, reason: "audience mismatch" };
    // Pin the Pub/Sub push service-account identity: Google only sets email_verified=true
    // for a verified SA, and email must match the one we configured for this subscription.
    if (claims.email !== expectedEmail) return { ok: false, reason: "service account email mismatch" };
    if (claims.email_verified !== true) return { ok: false, reason: "service account email not verified" };

    const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + tolerance < nowSec) {
      return { ok: false, reason: "token expired" };
    }
    if (typeof claims.iat === "number" && claims.iat - tolerance > nowSec) {
      return { ok: false, reason: "token not yet valid" };
    }

    // token authenticated — derive the Pub/Sub message id (dedup key) from the body
    const envelope = (() => {
      try {
        return JSON.parse(new TextDecoder().decode(input.rawBytes)) as {
          message?: { messageId?: unknown; message_id?: unknown };
        };
      } catch {
        return null;
      }
    })();
    const msg = envelope?.message;
    const messageId =
      (typeof msg?.messageId === "string" && msg.messageId) ||
      (typeof msg?.message_id === "string" && msg.message_id) ||
      "";
    if (!messageId) return { ok: false, reason: "missing pub/sub message id" };

    return { ok: true, externalId: messageId, eventKind: "gmail.push" };
  };
}

// Default verifier bound to global fetch/clock and Google's live JWKS endpoint.
export const verifyGmail: Verifier = createGmailVerifier();
