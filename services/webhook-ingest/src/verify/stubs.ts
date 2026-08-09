// Stub verifiers for sources not yet enabled in P0 (google-drive / gmail / stripe).
// The verification LOGIC is implemented (so the "偽物を通さない" property is unit-tested,
// tests #4/#5), but the ingress route rejects these sources with 404 until enabled.
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

// ---- gmail: Pub/Sub push OIDC — real verification requires Google JWKS (deferred).
// Stub stays closed until 9-B is decided (returns not-enabled).
export const verifyGmail: Verifier = async () => {
  return { ok: false, reason: "gmail verifier stub — not enabled until 9-B" };
};
