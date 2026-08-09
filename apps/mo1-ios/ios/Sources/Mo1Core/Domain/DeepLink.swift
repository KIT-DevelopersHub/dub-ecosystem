// DeepLink — Universal Links (https) primary + `dub://` fallback parsing
// (design §2-3: "Universal Links 本命 + dub:// フォールバック・devhub:// は廃止"),
// mirrors deeplink.ts. Resolves a URL to an in-app route.
import Foundation

public enum RouteName: String, Equatable, Sendable {
    case home, event, action, task, inbox, profile, chat
}

public struct Route: Equatable, Sendable {
    public var name: RouteName
    public var params: [String: String]
    public init(name: RouteName, params: [String: String] = [:]) {
        self.name = name; self.params = params
    }
}

private let HOME = Route(name: .home)
private let UNIVERSAL_HOSTS: Set<String> = ["m.developershub.jp", "developershub.jp"]

/// Map a path segment list to a route; unknown paths fall back to home.
private func routeFromSegments(_ segments: [String]) -> Route {
    let head = segments.first
    let id = segments.count > 1 ? segments[1] : nil
    switch head {
    case nil, "", "home":
        return HOME
    case "events":
        return id.map { Route(name: .event, params: ["eventId": $0]) } ?? HOME
    case "actions":
        return id.map { Route(name: .action, params: ["actionId": $0]) } ?? HOME
    case "tasks":
        return id.map { Route(name: .task, params: ["taskId": $0]) } ?? HOME
    case "inbox":
        return Route(name: .inbox)
    case "chat":
        return id.map { Route(name: .chat, params: ["channelId": $0]) } ?? Route(name: .chat)
    case "profile", "me":
        return Route(name: .profile)
    default:
        return HOME
    }
}

/// Parse an https Universal Link or a dub:// deeplink into a Route.
public func parseDeepLink(_ raw: String) -> Route {
    guard let comps = URLComponents(string: raw), let scheme = comps.scheme?.lowercased() else {
        return HOME
    }
    let pathSegments = comps.path.split(separator: "/").map(String.init)

    if scheme == "dub" {
        // dub://events/<id> -> host="events", path="/<id>"
        let host = comps.host ?? ""
        return routeFromSegments([host] + pathSegments)
    }

    if (scheme == "https" || scheme == "http"), let host = comps.host, UNIVERSAL_HOSTS.contains(host) {
        return routeFromSegments(pathSegments)
    }

    // devhub:// and any foreign origin are ignored (retired scheme / safety).
    return HOME
}
