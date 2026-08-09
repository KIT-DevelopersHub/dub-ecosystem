// Notification — inbox shapes consumed by the app. Mirrors the consumed subset
// of packages/types/src/notification.ts. NotificationType is an open vocabulary.
import Foundation

public typealias NotificationType = String

public struct InboxItem: Codable, Equatable, Sendable, Identifiable {
    public var id: Ids.NotificationId
    public var type: NotificationType
    public var title: String
    public var body: String
    public var readAt: ISODateTime?
    public var createdAt: ISODateTime
    public var resourceType: String?
    public var resourceId: String?
    public init(
        id: Ids.NotificationId, type: NotificationType, title: String, body: String,
        readAt: ISODateTime?, createdAt: ISODateTime, resourceType: String?, resourceId: String?
    ) {
        self.id = id; self.type = type; self.title = title; self.body = body
        self.readAt = readAt; self.createdAt = createdAt
        self.resourceType = resourceType; self.resourceId = resourceId
    }
}

public struct ListInboxQuery: Equatable, Sendable {
    public var cursor: String?
    public var limit: Int?
    public var unreadOnly: Bool?
    public init(cursor: String? = nil, limit: Int? = nil, unreadOnly: Bool? = nil) {
        self.cursor = cursor; self.limit = limit; self.unreadOnly = unreadOnly
    }
}

public typealias ListInboxResponse = Paginated<InboxItem>
