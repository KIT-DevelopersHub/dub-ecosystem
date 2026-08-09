// UI test helpers — a queue-driven Transport + WebAuthenticating stub so the
// ViewModels are exercised through the real MobileApiClient (integration-style).
import Foundation
import Mo1Core
@testable import Mo1UI

enum UIStep {
    case ok(TransportResponse)
    case fail(Error)
}

final class QueueTransport: Transport, @unchecked Sendable {
    private let steps: [UIStep]
    private let lock = NSLock()
    private var index = 0
    private(set) var calls: [TransportRequest] = []

    init(_ steps: [UIStep]) { self.steps = steps }

    func send(_ request: TransportRequest) async throws -> TransportResponse {
        lock.lock()
        calls.append(request)
        let step = steps[min(index, steps.count - 1)]
        index += 1
        lock.unlock()
        switch step {
        case .ok(let res): return res
        case .fail(let error): throw error
        }
    }
}

private let encoder = JSONEncoder()

func jsonStep<T: Encodable>(_ body: T, status: Int = 200) -> UIStep {
    .ok(TransportResponse(status: status, body: try! encoder.encode(body)))
}

func errorStep(_ code: String, status: Int, retryable: Bool = false) -> UIStep {
    let json = "{\"error\":{\"code\":\"\(code)\",\"message\":\"\(code)\",\"retryable\":\(retryable)}}"
    return .ok(TransportResponse(status: status, body: Data(json.utf8)))
}

@MainActor
func makeClient(_ steps: [UIStep], store: TokenStore = InMemoryTokenStore(), maxRetries: Int = 2, onExpired: (@Sendable () -> Void)? = nil) -> MobileApiClient {
    MobileApiClient(ApiClientConfig(
        baseURL: "https://m-api.developershub.jp",
        transport: QueueTransport(steps),
        tokenStore: store,
        maxRetries: maxRetries,
        sleep: { _ in },
        onSessionExpired: onExpired
    ))
}

func uiSampleTask(version: Int = 3, status: TaskStatus = .inProgress) -> DubTask {
    DubTask(
        id: "task_1", eventId: "evt_1", title: "Ship it", description: "do the thing",
        status: status, priority: .medium, assigneeId: "u1", dueAt: nil,
        origin: .internalOrigin, archivedAt: nil,
        createdAt: "2026-08-09T00:00:00Z", updatedAt: "2026-08-09T00:00:00Z", version: version
    )
}

/// WebAuthenticating stub that returns a canned callback URL (or throws).
final class StubWebAuth: WebAuthenticating, @unchecked Sendable {
    let result: Result<URL, Error>
    init(_ result: Result<URL, Error>) { self.result = result }
    @MainActor func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try result.get()
    }
}
