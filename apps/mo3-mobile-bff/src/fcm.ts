// FCM HTTP v1 provider — service account -> OAuth2 access token -> messages:send.
// Two network hops (token exchange + send) are each injectable so tests never
// touch the network or WebCrypto. Status mapping (design §push): 200 -> sent,
// UNREGISTERED / INVALID_ARGUMENT (404 / 400 with the FcmError code) -> token_invalid,
// anything else -> failed (dispatchPush audits the failure).
import type { mobile } from "@dub/types";
import type { SendResult } from "./push";
import { pemToDer, strToB64url, bytesToB64url } from "./apns";

/** Google service-account JSON (Workers Secret in production). */
export interface FcmServiceAccount {
  client_email: string;
  private_key: string; // PKCS#8 PEM (RSA) auth key
  token_uri?: string; // default: https://oauth2.googleapis.com/token
  project_id?: string; // used as projectId fallback
}

/** Resolves a Bearer access token for messages:send. Injectable for tests. */
export type FcmAccessTokenProvider = (
  sa: FcmServiceAccount,
  ctx: { fetchImpl: typeof fetch; nowSec: number },
) => Promise<string>;

export interface FcmSendOptions {
  serviceAccount: FcmServiceAccount;
  projectId: string;
  device: { pushToken: string };
  payload: mobile.MobilePushPayload;
  fetchImpl?: typeof fetch; // default: global fetch
  accessTokenProvider?: FcmAccessTokenProvider; // default: OAuth2 JWT-bearer flow
  now?: () => number; // ms clock; default Date.now
}

const SEND_HOST = "https://fcm.googleapis.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_INVALID_CODES = new Set(["UNREGISTERED", "INVALID_ARGUMENT"]);

/** Deliver one notification via FCM HTTP v1 and map the outcome to a SendResult. */
export async function sendFcm(opts: FcmSendOptions): Promise<SendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  const getToken = opts.accessTokenProvider ?? defaultAccessTokenProvider;

  const accessToken = await getToken(opts.serviceAccount, { fetchImpl: doFetch, nowSec });

  const res = await doFetch(`${SEND_HOST}/v1/projects/${opts.projectId}/messages:send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: buildFcmMessage(opts.device.pushToken, opts.payload) }),
  });

  return mapFcmStatus(res.status, await readErrorCode(res));
}

function buildFcmMessage(token: string, payload: mobile.MobilePushPayload): Record<string, unknown> {
  const message: Record<string, unknown> = {
    token,
    notification: { title: payload.title, body: payload.body },
  };
  if (payload.data) message.data = payload.data; // FCM v1 requires a string->string map
  return message;
}

/** 200 -> sent; a token-invalid FcmError code or 404 -> token_invalid; else failed. */
export function mapFcmStatus(status: number, errorCode: string | null): SendResult {
  if (status === 200) return "sent";
  if (errorCode && TOKEN_INVALID_CODES.has(errorCode)) return "token_invalid";
  if (status === 404) return "token_invalid"; // stale registration token
  return "failed";
}

/**
 * Extract the FcmError `errorCode` from a v1 error body, e.g.
 * `{ error: { details: [{ "@type": "…FcmError", errorCode: "UNREGISTERED" }] } }`.
 */
async function readErrorCode(res: { text(): Promise<string> }): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const parsed = JSON.parse(text) as {
      error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> };
    };
    for (const detail of parsed.error?.details ?? []) {
      if (typeof detail.errorCode === "string") return detail.errorCode;
    }
    return typeof parsed.error?.status === "string" ? parsed.error.status : null;
  } catch {
    return null;
  }
}

// ---- default OAuth2 access-token provider (RS256 JWT-bearer grant) ----

const defaultAccessTokenProvider: FcmAccessTokenProvider = async (sa, { fetchImpl, nowSec }) => {
  const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
  const assertion = await signGoogleJwt(sa, tokenUri, nowSec);
  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`fcm oauth token request failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string") throw new Error("fcm oauth response missing access_token");
  return json.access_token;
};

async function signGoogleJwt(sa: FcmServiceAccount, tokenUri: string, nowSec: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signingInput = `${strToB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${strToB64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  )}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}
