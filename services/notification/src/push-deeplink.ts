// Build the `data.deepLink` a mobile/WebView client navigates to when a push
// notification is tapped. The mobile clients (mo1-ios/mo2-android/de1-webview) parse
// this string with the shared deeplink grammar (Universal Links host + `dub://`
// fallback): the `dub://` form is host-independent so it works before the
// m-api/Universal-Link DNS is wired. Route grammar mirrors mo1-ios/src/deeplink.ts.
//
// Kept as a tiny pure function (no notification-service internals) so it stays loosely
// coupled to the delivery core and trivially unit-testable.

/** Map a delivery's (resourceType, resourceId) to a `dub://` deep link. Falls back to
 *  the inbox when the resource is untyped/unknown or its id is missing. */
export function buildPushDeepLink(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): string {
  const id = resourceId && resourceId.length > 0 ? resourceId : null;
  switch (resourceType) {
    case "task":
      return id ? `dub://tasks/${encodeURIComponent(id)}` : "dub://inbox";
    case "event":
      return id ? `dub://events/${encodeURIComponent(id)}` : "dub://inbox";
    case "action":
      return id ? `dub://actions/${encodeURIComponent(id)}` : "dub://inbox";
    case "channel":
      // chat channel deep link (parser: `chat/<id>` -> chat screen).
      return id ? `dub://chat/${encodeURIComponent(id)}` : "dub://inbox";
    default:
      // feedback / notification / release / null -> land in the inbox.
      return "dub://inbox";
  }
}
