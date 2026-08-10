// ChatViewModel — S8 Chat screen (design §2-1 S8). Wraps the pure ChatSession:
// loads message history over the ApiClient, fetches a DO-direct WS ticket,
// connects through the injected ChatSocketFactory, and mirrors the reconciled
// channel state into @Published for SwiftUI. Optimistic append + RT reconcile
// live in Mo1Core (shared with the vitest reference); this type is only the
// I/O + @Published bridge.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class ChatViewModel: ObservableObject {
    @Published public private(set) var messages: [ChatMessageVM] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var isConnected = false
    @Published public private(set) var errorKind: ClientErrorKind?
    @Published public var draft: String = ""

    private let api: MobileApi
    private let channelId: Ids.ChannelId
    private let selfId: Ids.UserId
    private let factory: ChatSocketFactory
    private var session: ChatSession?

    public init(api: MobileApi, channelId: Ids.ChannelId, selfId: Ids.UserId, factory: ChatSocketFactory) {
        self.api = api
        self.channelId = channelId
        self.selfId = selfId
        self.factory = factory
    }

    /// True when a message was authored by the signed-in user (right-aligned UI).
    public func isMine(_ message: ChatMessageVM) -> Bool { message.authorId == selfId }

    /// Load history, open the DO-direct socket, and start streaming RT events.
    public func start() async {
        guard session == nil else { return }
        let session = ChatSession(
            channelId: channelId, selfId: selfId, factory: factory,
            onChange: { [weak self] state in
                Task { @MainActor in self?.messages = state.messages }
            })
        self.session = session

        isLoading = true
        defer { isLoading = false }
        do {
            let history = try await api.listChatMessages(channelId, CursorQuery(limit: 50))
            session.loadHistory(history.items)
            let ticket = try await api.getChatWsTicket(channelId)
            session.connect(ticket)
            isConnected = true
            errorKind = nil
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }

    /// Optimistically send the current draft (no-op when blank).
    public func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        draft = ""
        session?.send(body)
    }

    public func disconnect() {
        session?.close()
        session = nil
        isConnected = false
    }
}
