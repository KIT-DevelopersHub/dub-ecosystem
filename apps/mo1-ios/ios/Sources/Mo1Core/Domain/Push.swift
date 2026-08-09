// Push — APNs payload -> deeplink route + badge (design §2-2 PushKit, test §7
// Push), mirrors push.ts. Routing/badge/type fields travel inside `data` (APNs
// custom string keys); read defensively and never crash on a missing key.
import Foundation

public struct ParsedPush: Equatable, Sendable {
    public var title: String
    public var body: String
    public var route: Route              // where a tap navigates (home if no deepLink)
    public var badge: Int?               // app-icon badge (nil = leave unchanged)
    public var notificationId: String?
    public var type: String?             // NotificationType (open vocabulary)
    public var correlationId: String?
}

private func numericBadge(_ value: String?) -> Int? {
    guard let value, let d = Double(value), d.isFinite else { return nil }
    return Int(d)
}

/// Interpret an incoming APNs payload; total (never throws).
public func parsePush(_ payload: MobilePushPayload) -> ParsedPush {
    let data = payload.data ?? [:]
    let deepLink = data["deepLink"]
    return ParsedPush(
        title: payload.title,
        body: payload.body,
        route: deepLink.map(parseDeepLink) ?? Route(name: .home),
        badge: numericBadge(data["badge"]),
        notificationId: data["notificationId"],
        type: data["type"],
        correlationId: data["correlationId"]
    )
}
