// Chat — chat-service shapes the S8 ChatView consumes. Mirrors the consumed
// subset of packages/types/src/chat.ts. The RT wire contract (`ChatRealtimeEvent`)
// is frozen; channel/message CRUD is STUB pending 9-C. RT土台 = Durable Objects,
// so the WebSocket is DO-direct (gateway-bypassing). `ChatRealtimeEvent` is a
// discriminated union keyed by `kind` — decoded from the WS text frame, encoded
// only in tests/preview.
import Foundation

/// Server -> client RT wire event (frozen · RT裁定#4). Also the DO fanout shape.
public enum ChatRealtimeEvent: Equatable, Sendable {
    case messageCreated(channelId: Ids.ChannelId, messageId: String, authorId: Ids.UserId, body: String, at: ISODateTime)
    case messageDeleted(channelId: Ids.ChannelId, messageId: String, at: ISODateTime)
    case memberAdded(channelId: Ids.ChannelId, userId: Ids.UserId, at: ISODateTime)
    case memberRemoved(channelId: Ids.ChannelId, userId: Ids.UserId, at: ISODateTime)

    /// the `channelId` common to every variant (the DO room the event targets).
    public var channelId: Ids.ChannelId {
        switch self {
        case let .messageCreated(channelId, _, _, _, _): return channelId
        case let .messageDeleted(channelId, _, _): return channelId
        case let .memberAdded(channelId, _, _): return channelId
        case let .memberRemoved(channelId, _, _): return channelId
        }
    }
}

extension ChatRealtimeEvent: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, channelId, messageId, authorId, body, at, userId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        let channelId = try c.decode(String.self, forKey: .channelId)
        let at = try c.decode(String.self, forKey: .at)
        switch kind {
        case "message.created":
            self = .messageCreated(
                channelId: channelId,
                messageId: try c.decode(String.self, forKey: .messageId),
                authorId: try c.decode(String.self, forKey: .authorId),
                body: try c.decode(String.self, forKey: .body),
                at: at)
        case "message.deleted":
            self = .messageDeleted(channelId: channelId, messageId: try c.decode(String.self, forKey: .messageId), at: at)
        case "member.added":
            self = .memberAdded(channelId: channelId, userId: try c.decode(String.self, forKey: .userId), at: at)
        case "member.removed":
            self = .memberRemoved(channelId: channelId, userId: try c.decode(String.self, forKey: .userId), at: at)
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown chat event kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .messageCreated(channelId, messageId, authorId, body, at):
            try c.encode("message.created", forKey: .kind)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(messageId, forKey: .messageId)
            try c.encode(authorId, forKey: .authorId)
            try c.encode(body, forKey: .body)
            try c.encode(at, forKey: .at)
        case let .messageDeleted(channelId, messageId, at):
            try c.encode("message.deleted", forKey: .kind)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(messageId, forKey: .messageId)
            try c.encode(at, forKey: .at)
        case let .memberAdded(channelId, userId, at):
            try c.encode("member.added", forKey: .kind)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(userId, forKey: .userId)
            try c.encode(at, forKey: .at)
        case let .memberRemoved(channelId, userId, at):
            try c.encode("member.removed", forKey: .kind)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(userId, forKey: .userId)
            try c.encode(at, forKey: .at)
        }
    }
}

public struct WsTicketResponse: Codable, Equatable, Sendable {
    /// short-lived; verified by the ChatRoom DO.
    public var ticket: String
    /// absolute URL to the Durable Object (DO-direct, gateway bypassed).
    public var doUrl: String
    public var expiresAt: ISODateTime
    public init(ticket: String, doUrl: String, expiresAt: ISODateTime) {
        self.ticket = ticket; self.doUrl = doUrl; self.expiresAt = expiresAt
    }
}

// STUB: 9-C 有効化後に確定 -----------------------------------------------------

public struct ChatChannel: Codable, Equatable, Sendable, Identifiable {
    public var id: Ids.ChannelId
    public var name: String
    public var createdAt: ISODateTime
    public init(id: Ids.ChannelId, name: String, createdAt: ISODateTime) {
        self.id = id; self.name = name; self.createdAt = createdAt
    }
}

public struct ChatMessage: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var channelId: Ids.ChannelId
    public var authorId: Ids.UserId
    public var body: String
    public var createdAt: ISODateTime
    public init(id: String, channelId: Ids.ChannelId, authorId: Ids.UserId, body: String, createdAt: ISODateTime) {
        self.id = id; self.channelId = channelId; self.authorId = authorId
        self.body = body; self.createdAt = createdAt
    }
}

public typealias ListChatChannelsResponse = Paginated<ChatChannel>
public typealias ListChatMessagesResponse = Paginated<ChatMessage>
