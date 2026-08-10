// Stripe webhook verifier (P0 live).
//   signature = Stripe-Signature "t=<ts>,v1=<hex>,..." = HMAC-SHA256(secret, "<ts>.<body>")
//   replay    = |now - t| must be within STRIPE_TOLERANCE_SEC
//   dedup id  = event.id (from the body; signature already proves a trusted sender)
//   kind      = event.type
// Secret rotation: accept a match against STRIPE_WEBHOOK_SECRET or ..._NEXT.
import { hmacMatchesAny } from "../crypto";
import { STRIPE_TOLERANCE_SEC } from "../env";
import type { Verifier } from "./types";

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
