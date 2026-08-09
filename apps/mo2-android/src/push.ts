// FCM push handling (§2-3, test #5). Parse the incoming data message into the
// frozen MobilePushPayload, then resolve the tap target via the deep-link table.
// deepLink travels in payload.data.deepLink (FCM data / APNs userInfo common).
import type { MobilePushPayload } from "./contract";
import { parseDeepLink, type Route } from "./deep-link";

export interface ParsedPush {
  payload: MobilePushPayload;
  /** Route to navigate to on notification tap (unknown if no/invalid deepLink). */
  tapRoute: Route;
  notificationId: string | null;
  badge: number | null;
}

/** Parse a raw FCM message (title/body top-level, data map) into ParsedPush. */
export function parsePush(raw: {
  title?: unknown;
  body?: unknown;
  data?: Record<string, unknown> | undefined;
}): ParsedPush {
  const data = normalizeData(raw.data);
  const payload: MobilePushPayload = {
    title: asString(raw.title) ?? asString(data?.title) ?? "",
    body: asString(raw.body) ?? asString(data?.body) ?? "",
    ...(data ? { data } : {}),
  };
  const deepLink = data?.deepLink ?? "";
  const tapRoute = deepLink ? parseDeepLink(deepLink) : { screen: "unknown" as const, raw: "" };
  const badgeNum = data?.badge !== undefined ? Number(data.badge) : NaN;
  return {
    payload,
    tapRoute,
    notificationId: data?.notificationId ?? null,
    badge: Number.isFinite(badgeNum) ? badgeNum : null,
  };
}

function normalizeData(data: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!data) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
