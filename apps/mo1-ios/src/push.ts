// push — APNs payload -> deeplink route + badge (design §2-2 PushKit, test §7
// Push). The frozen mobile.MobilePushPayload keeps { title, body, data? }; the
// routing/badge/type fields the design lists travel inside `data` (string map,
// APNs custom keys). We read them defensively and never crash on a missing key.
import type { mobile } from "@dub/types";
import { parseDeepLink, type Route } from "./deeplink.js";

export interface ParsedPush {
  title: string;
  body: string;
  route: Route; // where a tap navigates (home if no deepLink)
  badge: number | null; // app-icon badge (null = leave unchanged)
  notificationId: string | null;
  type: string | null; // notification.NotificationType (open vocabulary)
  correlationId: string | null;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Interpret an incoming APNs payload; total (never throws). */
export function parsePush(payload: mobile.MobilePushPayload): ParsedPush {
  const data = payload.data ?? {};
  const deepLink = data.deepLink;
  return {
    title: payload.title,
    body: payload.body,
    route: deepLink ? parseDeepLink(deepLink) : { name: "home", params: {} },
    badge: num(data.badge),
    notificationId: data.notificationId ?? null,
    type: data.type ?? null,
    correlationId: data.correlationId ?? null,
  };
}
