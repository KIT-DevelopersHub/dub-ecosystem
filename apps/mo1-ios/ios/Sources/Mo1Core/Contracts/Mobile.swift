// Mobile — the MO3 mobile-bff namespace the app consumes (OpenAPI generation
// source). Mirrors packages/types/src/mobile.ts. `MobileAuthSession` is the
// client-local exchange/refresh envelope over the frozen auth.SessionInfo — to
// be replaced by the generated `mobile.MobileAuthSession` once MO3 freezes it
// (see apps/mo1-ios/README.md "Contract gap").
import Foundation

public enum MobilePlatform: String, Codable, Equatable, Sendable {
    case ios, android
}

public struct MobileHomeResponse: Codable, Equatable, Sendable {
    public var upcomingEvents: [EventSummary]
    public var myTasks: [TaskSummary]
    public var unreadCount: Int
    public init(upcomingEvents: [EventSummary], myTasks: [TaskSummary], unreadCount: Int) {
        self.upcomingEvents = upcomingEvents; self.myTasks = myTasks; self.unreadCount = unreadCount
    }
}

public struct MobileEventOverviewResponse: Codable, Equatable, Sendable {
    public var event: EventSummary
    public var capabilities: [PermissionKey]
    public init(event: EventSummary, capabilities: [PermissionKey]) {
        self.event = event; self.capabilities = capabilities
    }
}

public struct RegisterDeviceRequest: Codable, Equatable, Sendable {
    public var platform: MobilePlatform
    public var pushToken: String
    public init(platform: MobilePlatform, pushToken: String) {
        self.platform = platform; self.pushToken = pushToken
    }
}

public struct RegisterDeviceResponse: Codable, Equatable, Sendable {
    public var deviceId: String
    public init(deviceId: String) { self.deviceId = deviceId }
}

public struct MobilePushPayload: Codable, Equatable, Sendable {
    public var title: String
    public var body: String
    public var data: [String: String]?
    public init(title: String, body: String, data: [String: String]? = nil) {
        self.title = title; self.body = body; self.data = data
    }
}

/// Client-local auth envelope (see file header): `{ token, session }`.
public struct MobileAuthSession: Codable, Equatable, Sendable {
    public var token: String
    public var session: SessionInfo
    public init(token: String, session: SessionInfo) {
        self.token = token; self.session = session
    }
}
