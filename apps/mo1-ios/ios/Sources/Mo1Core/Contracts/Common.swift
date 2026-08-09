// Common — shared primitives consumed from @dub/types `common` namespace
// (IDs, pagination, optimistic-lock version, the mobile API prefix constant).
// These mirror packages/types/src/common.ts; the Swift app never re-defines the
// contract, it consumes the frozen shapes.
import Foundation

public enum Ids {
    public typealias UserId = String
    public typealias EventId = String
    public typealias ActionId = String
    public typealias TaskId = String
    public typealias ChannelId = String
    public typealias NotificationId = String
    public typealias OrgId = String
}

/// ISO8601 UTC timestamp string, e.g. "2026-08-09T05:00:00Z".
public typealias ISODateTime = String
/// epoch-ms `number` exception (theme10): session-expiry fields only.
public typealias EpochMs = Double

/// All mobile traffic is prefixed with `/m/v1` (common.MOBILE_API_PREFIX).
public let MOBILE_API_PREFIX = "/m/v1"

/// Opaque cursor pagination (offset paging forbidden, D3).
public struct CursorQuery: Equatable, Sendable {
    public var cursor: String?
    public var limit: Int?
    public init(cursor: String? = nil, limit: Int? = nil) {
        self.cursor = cursor
        self.limit = limit
    }
}

/// Paginated<T>: `items` + opaque `nextCursor` (null = end of results).
public struct Paginated<T: Codable & Equatable>: Codable, Equatable {
    public var items: [T]
    public var nextCursor: String?
    public init(items: [T], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}
