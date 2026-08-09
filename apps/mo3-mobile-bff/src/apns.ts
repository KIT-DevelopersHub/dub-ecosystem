// APNs HTTP/2 provider — p8 auth key -> ES256 provider JWT -> POST /3/device/<token>.
// The send is a pure function with an injectable fetch + JWT signer so tests never
// touch the network or WebCrypto. Status mapping (design §push): 200 -> sent,
// 410 / Unregistered / BadDeviceToken -> token_invalid, anything else -> failed
// (dispatchPush audits the failure). No credentials in play here — the adapter
// guards that before calling send.
import type { mobile } from "@dub/types";
import type { SendResult } from "./push";

/** APNs provider-token credentials (Workers Secrets in production). */
export interface ApnsCredentials {
  keyP8: string; // PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----…") of the .p8 auth key
  keyId: string; // 10-char Key ID -> JWT header `kid`
  teamId: string; // 10-char Team ID -> JWT `iss` claim
  bundleId: string; // app bundle id -> `apns-topic` header
}

/** Signs the APNs provider JWT (ES256 over P-256/SHA-256). Injectable for tests. */
export type Es256Signer = (creds: ApnsCredentials, nowSec: number) => Promise<string>;

export interface ApnsSendOptions {
  credentials: ApnsCredentials;
  device: { pushToken: string };
  payload: mobile.MobilePushPayload;
  fetchImpl?: typeof fetch; // default: global fetch
  signer?: Es256Signer; // default: WebCrypto ES256 signer
  host?: string; // default: api.push.apple.com (use api.sandbox.push.apple.com for dev)
  now?: () => number; // ms clock; default Date.now (deterministic in tests)
}

const DEFAULT_HOST = "api.push.apple.com";
const TOKEN_INVALID_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/** Deliver one alert to APNs and map the HTTP outcome to a SendResult. */
export async function sendApns(opts: ApnsSendOptions): Promise<SendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sign = opts.signer ?? defaultEs256Signer;
  const host = opts.host ?? DEFAULT_HOST;
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);

  const jwt = await sign(opts.credentials, nowSec);
  const body = buildApnsBody(opts.payload);

  const res = await doFetch(`https://${host}/3/device/${opts.device.pushToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": opts.credentials.bundleId,
      "apns-push-type": "alert",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return mapApnsStatus(res.status, await readReason(res));
}

/** APNs payload: standard `aps` alert plus flat custom keys (per Apple's format). */
function buildApnsBody(payload: mobile.MobilePushPayload): Record<string, unknown> {
  return {
    aps: { alert: { title: payload.title, body: payload.body } },
    ...(payload.data ?? {}),
  };
}

/** 200 -> sent, 410 or a token-invalid `reason` -> token_invalid, else failed. */
export function mapApnsStatus(status: number, reason: string | null): SendResult {
  if (status === 200) return "sent";
  if (status === 410) return "token_invalid";
  if (reason && TOKEN_INVALID_REASONS.has(reason)) return "token_invalid";
  return "failed";
}

/** Best-effort parse of APNs's `{ "reason": "…" }` error body; null on empty/non-JSON. */
async function readReason(res: { text(): Promise<string> }): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const parsed = JSON.parse(text) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

// ---- default WebCrypto ES256 signer ----

async function defaultEs256Signer(creds: ApnsCredentials, nowSec: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(creds.keyP8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signingInput = `${strToB64url(JSON.stringify({ alg: "ES256", kid: creds.keyId, typ: "JWT" }))}.${strToB64url(
    JSON.stringify({ iss: creds.teamId, iat: nowSec }),
  )}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

// ---- base64url / PEM helpers (shared shape with fcm.ts, kept local per module) ----

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
