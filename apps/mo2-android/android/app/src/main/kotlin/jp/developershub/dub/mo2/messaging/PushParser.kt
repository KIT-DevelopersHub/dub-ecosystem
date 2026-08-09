// FCM push parsing (§2-3, test #5). 1:1 port of push.ts. Parse an incoming FCM
// data message into the frozen MobilePushPayload, then resolve the tap target via
// the deep-link table. deepLink travels in data["deepLink"] (FCM data map).
package jp.developershub.dub.mo2.messaging

import jp.developershub.dub.mo2.core.model.MobilePushPayload
import jp.developershub.dub.mo2.navigation.Route
import jp.developershub.dub.mo2.navigation.parseDeepLink

data class ParsedPush(
    val payload: MobilePushPayload,
    /** Route to navigate to on notification tap (Unknown if no/invalid deepLink). */
    val tapRoute: Route,
    val notificationId: String?,
    val badge: Int?,
)

/**
 * Parse a raw FCM message (optional title/body from the notification block, plus
 * the data map) into ParsedPush. FCM already delivers data values as strings.
 */
fun parsePush(
    title: String?,
    body: String?,
    data: Map<String, String>?,
): ParsedPush {
    val normalized = data?.takeIf { it.isNotEmpty() }
    val payload = MobilePushPayload(
        title = title ?: normalized?.get("title") ?: "",
        body = body ?: normalized?.get("body") ?: "",
        data = normalized,
    )
    val deepLink = normalized?.get("deepLink").orEmpty()
    val tapRoute = if (deepLink.isNotEmpty()) parseDeepLink(deepLink) else Route.Unknown("")
    val badge = normalized?.get("badge")?.toIntOrNull()
    return ParsedPush(
        payload = payload,
        tapRoute = tapRoute,
        notificationId = normalized?.get("notificationId"),
        badge = badge,
    )
}
