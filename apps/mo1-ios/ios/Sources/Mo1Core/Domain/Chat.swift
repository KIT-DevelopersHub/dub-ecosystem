// Chat — ChatView (S8) channel/message view-model + optimistic append over the
// frozen `chat` namespace (design §2-1 S8), mirrors chat.ts. Two jobs:
//   1. 楽観追記 — the user's message shows immediately (status .pending); the
//      echoed `message.created` RT event reconciles it to .sent (or markFailed
//      flips it to .failed). Reconnect re-delivery is idempotent by messageId.
//   2. WS transport injection — the DO WebSocket sits behind a
//      `ChatSocketFactory`; `StubChatSocketFactory` drives it in tests exactly
//      like the real URLSessionWebSocketTask transport.
// The reducers are pure so the ChatViewModel and its tests share one impl.
import Foundation

public enum ChatMessageStatus: String, Equatable, Sendable {
    case pending, sent, failed
}

public struct ChatMessageVM: Equatable, Sendable, Identifiable {
    /// server MessageId once confirmed; the local id while still .pending.
    public var id: String
    public var channelId: Ids.ChannelId
    public var authorId: Ids.UserId
    public var body: String
    public var createdAt: ISODateTime
    public var status: ChatMessageStatus
    /// local correlation id for an optimistic message (nil once confirmed).
    public var localId: String?
    public init(
        id: String, channelId: Ids.ChannelId, authorId: Ids.UserId, body: String,
        createdAt: ISODateTime, status: ChatMessageStatus, localId: String? = nil
    ) {
        self.id = id; self.channelId = channelId; self.authorId = authorId; self.body = body
        self.createdAt = createdAt; self.status = status; self.localId = localId
    }
}

public struct ChatChannelState: Equatable, Sendable {
    public var channelId: Ids.ChannelId
    /// chronological, oldest -> newest.
    public var messages: [ChatMessageVM]
    public init(channelId: Ids.ChannelId, messages: [ChatMessageVM] = []) {
        self.channelId = channelId; self.messages = messages
    }
}

public func emptyChannel(_ channelId: Ids.ChannelId) -> ChatChannelState {
    ChatChannelState(channelId: channelId, messages: [])
}

// epoch-ms of an ISO timestamp (unparseable -> 0, keeps stable order).
private func ms(_ s: String) -> Double {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d.timeIntervalSince1970 * 1000 }
    let g = ISO8601DateFormatter(); g.formatOptions = [.withInternetDateTime]
    if let d = g.date(from: s) { return d.timeIntervalSince1970 * 1000 }
    return 0
}

/// Stable sort by createdAt; ties keep insertion order.
private func sortedMessages(_ messages: [ChatMessageVM]) -> [ChatMessageVM] {
    messages.enumerated()
        .sorted { a, b in
            let ka = ms(a.element.createdAt), kb = ms(b.element.createdAt)
            return ka != kb ? ka < kb : a.offset < b.offset
        }
        .map { $0.element }
}

/// Seed / merge server history (`GET messages`). Existing ids win over dupes.
public func loadHistory(_ state: ChatChannelState, _ history: [ChatMessage]) -> ChatChannelState {
    var seen = Set(state.messages.map { $0.id })
    var merged = state.messages
    for m in history {
        if seen.contains(m.id) { continue }
        seen.insert(m.id)
        merged.append(ChatMessageVM(
            id: m.id, channelId: m.channelId, authorId: m.authorId, body: m.body,
            createdAt: m.createdAt, status: .sent))
    }
    return ChatChannelState(channelId: state.channelId, messages: sortedMessages(merged))
}

public struct OptimisticSend: Equatable, Sendable {
    public var localId: String
    public var authorId: Ids.UserId
    public var body: String
    public var createdAt: ISODateTime
    public init(localId: String, authorId: Ids.UserId, body: String, createdAt: ISODateTime) {
        self.localId = localId; self.authorId = authorId; self.body = body; self.createdAt = createdAt
    }
}

/// Append the user's just-sent message as .pending (optimistic).
public func appendOptimistic(_ state: ChatChannelState, _ send: OptimisticSend) -> ChatChannelState {
    let msg = ChatMessageVM(
        id: send.localId, channelId: state.channelId, authorId: send.authorId, body: send.body,
        createdAt: send.createdAt, status: .pending, localId: send.localId)
    return ChatChannelState(channelId: state.channelId, messages: sortedMessages(state.messages + [msg]))
}

/// Flip a still-pending optimistic message to .failed (send error / timeout).
public func markFailed(_ state: ChatChannelState, _ localId: String) -> ChatChannelState {
    var changed = false
    let messages = state.messages.map { m -> ChatMessageVM in
        if m.localId == localId && m.status == .pending {
            changed = true
            var n = m; n.status = .failed; return n
        }
        return m
    }
    return changed ? ChatChannelState(channelId: state.channelId, messages: messages) : state
}

/// Fold a frozen RT event into the channel:
/// - message.created: confirm the matching pending optimistic message (same
///   author + body), else append it as a new .sent message. Idempotent by
///   messageId so WS reconnect re-delivery is a no-op.
/// - message.deleted: drop the message (by id).
/// - member.added / member.removed: no message-list change.
public func applyRealtimeEvent(_ state: ChatChannelState, _ ev: ChatRealtimeEvent) -> ChatChannelState {
    guard ev.channelId == state.channelId else { return state }

    switch ev {
    case let .messageCreated(channelId, messageId, authorId, body, at):
        if state.messages.contains(where: { $0.id == messageId }) { return state } // already have it
        if let idx = state.messages.firstIndex(where: { $0.status == .pending && $0.authorId == authorId && $0.body == body }) {
            var messages = state.messages
            var m = messages[idx]
            m.id = messageId; m.createdAt = at; m.status = .sent; m.localId = nil
            messages[idx] = m
            return ChatChannelState(channelId: state.channelId, messages: sortedMessages(messages))
        }
        let created = ChatMessageVM(
            id: messageId, channelId: channelId, authorId: authorId, body: body, createdAt: at, status: .sent)
        return ChatChannelState(channelId: state.channelId, messages: sortedMessages(state.messages + [created]))
    case let .messageDeleted(_, messageId, _):
        let messages = state.messages.filter { $0.id != messageId }
        return messages.count == state.messages.count ? state : ChatChannelState(channelId: state.channelId, messages: messages)
    case .memberAdded, .memberRemoved:
        return state
    }
}

// ---- WS transport (injected; DO-direct, gateway-bypassing) -----------------

public struct ChatSocketHandlers: Sendable {
    public var onEvent: @Sendable (ChatRealtimeEvent) -> Void
    public var onOpen: (@Sendable () -> Void)?
    public var onClose: (@Sendable () -> Void)?
    public var onError: (@Sendable (Error) -> Void)?
    public init(
        onEvent: @escaping @Sendable (ChatRealtimeEvent) -> Void,
        onOpen: (@Sendable () -> Void)? = nil,
        onClose: (@Sendable () -> Void)? = nil,
        onError: (@Sendable (Error) -> Void)? = nil
    ) {
        self.onEvent = onEvent; self.onOpen = onOpen; self.onClose = onClose; self.onError = onError
    }
}

/// Outbound client -> ChatRoom-DO frame. The frozen `chat` namespace publishes
/// the inbound `ChatRealtimeEvent` wire contract but NOT the outbound send frame
/// (message CRUD is STUB pending 9-C), so this is a client-local placeholder —
/// replace with the generated type once chat-service freezes it (README gap).
public struct ChatSendFrame: Codable, Equatable, Sendable {
    public var kind: String
    public var localId: String
    public var body: String
    public init(localId: String, body: String) {
        self.kind = "message.send"; self.localId = localId; self.body = body
    }
}

/// Live socket handle (mirrors Swift URLSessionWebSocketTask).
public protocol ChatSocket: AnyObject, Sendable {
    func send(_ frame: ChatSendFrame)
    func close()
}

/// Injected factory: opens a DO-direct socket for one ticket.
public protocol ChatSocketFactory: Sendable {
    func connect(url: String, handlers: ChatSocketHandlers) -> ChatSocket
}

/// Append the DO ticket to the DO-direct URL the socket connects to.
public func chatSocketUrl(_ ticket: WsTicketResponse) -> String {
    guard var comps = URLComponents(string: ticket.doUrl) else { return ticket.doUrl }
    var items = comps.queryItems ?? []
    items.removeAll { $0.name == "ticket" }
    items.append(URLQueryItem(name: "ticket", value: ticket.ticket))
    comps.queryItems = items
    return comps.string ?? ticket.doUrl
}

/// ChatSession ties the injected socket to the optimistic reducer: incoming RT
/// events reconcile state, `send()` appends optimistically then transmits. All
/// state changes surface through `onChange` (the SwiftUI @Published mirror).
public final class ChatSession: @unchecked Sendable {
    private let channelId: Ids.ChannelId
    private let selfId: Ids.UserId
    private let factory: ChatSocketFactory
    private let onChange: (@Sendable (ChatChannelState) -> Void)?
    private let now: @Sendable () -> Double
    private let lock = NSLock()
    private var seq = 0
    private let newLocalIdOverride: (@Sendable () -> String)?
    private var state: ChatChannelState
    private var socket: ChatSocket?

    public init(
        channelId: Ids.ChannelId,
        selfId: Ids.UserId,
        factory: ChatSocketFactory,
        onChange: (@Sendable (ChatChannelState) -> Void)? = nil,
        newLocalId: (@Sendable () -> String)? = nil,
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.channelId = channelId
        self.selfId = selfId
        self.factory = factory
        self.onChange = onChange
        self.newLocalIdOverride = newLocalId
        self.now = now
        self.state = emptyChannel(channelId)
    }

    public var currentState: ChatChannelState {
        lock.lock(); defer { lock.unlock() }
        return state
    }

    private func nextLocalId() -> String {
        if let o = newLocalIdOverride { return o() }
        lock.lock(); let s = seq; seq += 1; lock.unlock()
        return "local_\(Int(now()))_\(s)"
    }

    /// Merge server history into the channel (call before/after connect).
    public func loadHistory(_ history: [ChatMessage]) {
        commit(Mo1Core.loadHistory(currentState, history))
    }

    /// Open the DO-direct socket for a fetched ticket.
    public func connect(_ ticket: WsTicketResponse) {
        let sock = factory.connect(url: chatSocketUrl(ticket), handlers: ChatSocketHandlers(
            onEvent: { [weak self] ev in
                guard let self else { return }
                self.commit(applyRealtimeEvent(self.currentState, ev))
            }))
        lock.lock(); socket = sock; lock.unlock()
    }

    /// Optimistically append the message and transmit it; returns its localId.
    @discardableResult
    public func send(_ body: String) -> String {
        let localId = nextLocalId()
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let createdAt = f.string(from: Date(timeIntervalSince1970: now() / 1000))
        commit(appendOptimistic(currentState, OptimisticSend(localId: localId, authorId: selfId, body: body, createdAt: createdAt)))
        lock.lock(); let sock = socket; lock.unlock()
        if let sock {
            sock.send(ChatSendFrame(localId: localId, body: body))
        } else {
            commit(markFailed(currentState, localId))
        }
        return localId
    }

    public func close() {
        lock.lock(); let sock = socket; socket = nil; lock.unlock()
        sock?.close()
    }

    private func commit(_ next: ChatChannelState) {
        lock.lock()
        if next == state { lock.unlock(); return }
        state = next
        lock.unlock()
        onChange?(next)
    }
}

// ---- test / preview stub ----------------------------------------------------

/// In-memory ChatSocket for tests/previews (no real WebSocket). Records the
/// frames the client transmitted and can `emit` server RT events downstream.
public final class StubChatSocket: ChatSocket, @unchecked Sendable {
    public let url: String
    private let handlers: ChatSocketHandlers
    private let lock = NSLock()
    private var _sent: [ChatSendFrame] = []
    private var _closed = false

    init(url: String, handlers: ChatSocketHandlers) {
        self.url = url; self.handlers = handlers
    }

    /// frames the client transmitted (assert outbound wire in tests).
    public var sent: [ChatSendFrame] {
        lock.lock(); defer { lock.unlock() }; return _sent
    }
    public var closed: Bool {
        lock.lock(); defer { lock.unlock() }; return _closed
    }

    public func send(_ frame: ChatSendFrame) {
        lock.lock(); let isClosed = _closed; if !isClosed { _sent.append(frame) }; lock.unlock()
    }

    /// push a server RT event down to the session.
    public func emit(_ ev: ChatRealtimeEvent) { handlers.onEvent(ev) }

    public func close() {
        lock.lock(); _closed = true; lock.unlock()
        handlers.onClose?()
    }
}

/// ChatSocketFactory that hands out `StubChatSocket`s (tests / SwiftUI previews).
public final class StubChatSocketFactory: ChatSocketFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var _socket: StubChatSocket?

    public init() {}

    /// the socket from the most recent connect() (nil before first connect).
    public var socket: StubChatSocket? {
        lock.lock(); defer { lock.unlock() }; return _socket
    }

    public func connect(url: String, handlers: ChatSocketHandlers) -> ChatSocket {
        let s = StubChatSocket(url: url, handlers: handlers)
        lock.lock(); _socket = s; lock.unlock()
        handlers.onOpen?()
        return s
    }
}
