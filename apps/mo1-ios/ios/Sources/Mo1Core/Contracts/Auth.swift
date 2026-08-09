// Auth — auth-service shapes used by the mobile exchange/refresh flow.
// Mirrors packages/types/src/auth.ts (consumed subset).
import Foundation

public enum AuthClient: String, Codable, Equatable, Sendable {
    case web, mobile
}

public struct SessionInfo: Codable, Equatable, Sendable {
    public var userId: Ids.UserId
    public var client: AuthClient
    public var sessionExpiresAt: EpochMs // epoch-ms exception (theme10)
    public init(userId: Ids.UserId, client: AuthClient, sessionExpiresAt: EpochMs) {
        self.userId = userId; self.client = client; self.sessionExpiresAt = sessionExpiresAt
    }
}

public struct MobileExchangeRequest: Codable, Equatable, Sendable {
    public var code: String
    public init(code: String) { self.code = code }
}

/// mobile path uses the current bearer as the refresh credential (theme8), so
/// the JSON body is empty `{}` — the optional field is nil and omitted.
public struct AuthRefreshRequest: Codable, Equatable, Sendable {
    public var refreshToken: String?
    public init(refreshToken: String? = nil) { self.refreshToken = refreshToken }
}
