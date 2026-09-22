// WNS (Windows Notification Service) provider — Azure AD app registration ->
// client_credentials OAuth2 token -> POST to the device Channel URI with a toast
// XML payload. The two network hops (token exchange + send) are each injectable so
// tests never touch the network. Status mapping (mirrors apns/fcm §push):
// 200 -> sent; 404 / 410 / 403 (channel expired or revoked) -> token_invalid;
// anything else -> failed (dispatchPush audits the failure).
//
// Unlike APNs/FCM the "push token" is the full Channel URI itself (an
// https://*.notify.windows.com/... URL Windows mints per app+device), so the send
// POSTs directly to device.pushToken rather than a fixed provider host.
import type { mobile } from "@dub/types";
import type { SendResult } from "./push";

/** WNS credentials: an Azure AD app registration (Workers Secrets in production). */
export interface WnsCredentials {
  packageSid: string; // ms-app://... Package SID -> OAuth `client_id`
  clientSecret: string; // Azure AD app client secret -> OAuth `client_secret`
  tenantId?: string; // Azure AD tenant; default "common" (WNS accepts the legacy login.live endpoint too)
}

/** Resolves a Bearer access token for the Channel URI POST. Injectable for tests. */
export type WnsAccessTokenProvider = (
  creds: WnsCredentials,
  ctx: { fetchImpl: typeof fetch },
) => Promise<string>;

export interface WnsSendOptions {
  credentials: WnsCredentials;
  device: { pushToken: string }; // pushToken == the WNS Channel URI
  payload: mobile.MobilePushPayload;
  fetchImpl?: typeof fetch; // default: global fetch
  accessTokenProvider?: WnsAccessTokenProvider; // default: client_credentials grant
  tokenUri?: string; // override the OAuth token endpoint (tests / sovereign clouds)
}

// WNS OAuth2 token endpoint (Microsoft's documented WNS auth host) and scope.
const DEFAULT_TOKEN_URI = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const WNS_SCOPE = "https://wns.windows.com/.default";
const TOKEN_INVALID_STATUSES = new Set([403, 404, 410]);

/** Deliver one toast to a WNS Channel URI and map the HTTP outcome to a SendResult. */
export async function sendWns(opts: WnsSendOptions): Promise<SendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const getToken = opts.accessTokenProvider ?? defaultAccessTokenProvider;

  const accessToken = await getToken(opts.credentials, { fetchImpl: doFetch });
  const xml = buildToastXml(opts.payload);

  const res = await doFetch(opts.device.pushToken, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "text/xml",
      "x-wns-type": "wns/toast",
    },
    body: xml,
  });

  return mapWnsStatus(res.status);
}

/**
 * WNS toast XML (ToastGeneric binding). Custom key/value data is carried on the
 * toast's `launch` attribute as a query string, so a tapped toast hands the app the
 * same data map (deepLink/notificationId) the other transports deliver via `data`.
 */
export function buildToastXml(payload: mobile.MobilePushPayload): string {
  const launch = payload.data ? encodeLaunch(payload.data) : "";
  const launchAttr = launch ? ` launch="${xmlEscape(launch)}"` : "";
  return (
    `<toast${launchAttr}>` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(payload.title)}</text>` +
    `<text>${xmlEscape(payload.body)}</text>` +
    `</binding></visual>` +
    `</toast>`
  );
}

/** 200 -> sent; a channel-gone status (403/404/410) -> token_invalid; else failed. */
export function mapWnsStatus(status: number): SendResult {
  if (status === 200) return "sent";
  if (TOKEN_INVALID_STATUSES.has(status)) return "token_invalid";
  return "failed";
}

/** Serialise the custom data map into a URL-encoded query string for `launch`. */
function encodeLaunch(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---- default client_credentials access-token provider ----

const defaultAccessTokenProvider: WnsAccessTokenProvider = async (creds, { fetchImpl }) => {
  const tokenUri = creds.tenantId
    ? `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`
    : DEFAULT_TOKEN_URI;
  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.packageSid,
      client_secret: creds.clientSecret,
      scope: WNS_SCOPE,
    }).toString(),
  });
  if (!res.ok) throw new Error(`wns oauth token request failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string") throw new Error("wns oauth response missing access_token");
  return json.access_token;
};
