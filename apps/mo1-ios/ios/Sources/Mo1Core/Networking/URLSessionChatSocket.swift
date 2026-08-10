// URLSessionChatSocket — the production DO-direct WebSocket transport for S8
// chat, conforming to the injectable `ChatSocket`/`ChatSocketFactory` seams the
// pure ChatSession drives. Frames are JSON text: outbound `ChatSendFrame`,
// inbound `ChatRealtimeEvent`. Live delivery still depends on the 9-C ChatRoom
// DO being reachable at the ticket's `doUrl`; tests continue to use
// `StubChatSocketFactory`, which mirrors this class's contract exactly.
import Foundation

/// URLSessionWebSocketTask-backed ChatSocket. Reads are a self-rescheduling
/// receive loop; malformed frames are surfaced via `onError` and skipped
/// (never crash — design §6). Idempotent, thread-safe close.
public final class URLSessionChatSocket: NSObject, ChatSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let handlers: ChatSocketHandlers
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let lock = NSLock()
    private var closed = false

    init(task: URLSessionWebSocketTask, handlers: ChatSocketHandlers) {
        self.task = task
        self.handlers = handlers
        super.init()
    }

    func start() {
        task.resume()
        handlers.onOpen?()
        receiveLoop()
    }

    public func send(_ frame: ChatSendFrame) {
        guard let data = try? encoder.encode(frame), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if let error { self?.handlers.onError?(error) }
        }
    }

    public func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        lock.unlock()
        task.cancel(with: .goingAway, reason: nil)
        handlers.onClose?()
    }

    private func isClosed() -> Bool {
        lock.lock(); defer { lock.unlock() }; return closed
    }

    private func receiveLoop() {
        task.receive { [weak self] result in
            guard let self, !self.isClosed() else { return }
            switch result {
            case .success(let message):
                self.dispatch(message)
                self.receiveLoop() // reschedule for the next frame
            case .failure(let error):
                if !self.isClosed() { self.handlers.onError?(error) }
            }
        }
    }

    private func dispatch(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .string(let text): data = text.data(using: .utf8)
        case .data(let d): data = d
        @unknown default: data = nil
        }
        guard let data, let ev = try? decoder.decode(ChatRealtimeEvent.self, from: data) else {
            handlers.onError?(DubClientError(code: "CHAT_FRAME_DECODE_FAILED", status: 0, message: "unparseable RT frame", retryable: false, kind: .unknown))
            return
        }
        handlers.onEvent(ev)
    }
}

/// Production `ChatSocketFactory` opening a real DO-direct WebSocket per ticket.
public final class URLSessionChatSocketFactory: ChatSocketFactory, @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func connect(url: String, handlers: ChatSocketHandlers) -> ChatSocket {
        guard let u = URL(string: url) else {
            // Surface the bad URL and hand back an inert socket (never crash).
            handlers.onError?(DubClientError(code: "CHAT_WS_BAD_URL", status: 0, message: "invalid ws url", retryable: false, kind: .unknown))
            return InertChatSocket(handlers: handlers)
        }
        let task = session.webSocketTask(with: u)
        let socket = URLSessionChatSocket(task: task, handlers: handlers)
        socket.start()
        return socket
    }
}

/// No-op socket returned when a URL cannot be formed (keeps the seam total).
private final class InertChatSocket: ChatSocket, @unchecked Sendable {
    private let handlers: ChatSocketHandlers
    init(handlers: ChatSocketHandlers) { self.handlers = handlers }
    func send(_ frame: ChatSendFrame) {}
    func close() { handlers.onClose?() }
}
