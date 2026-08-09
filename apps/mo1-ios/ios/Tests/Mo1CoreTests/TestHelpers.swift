// Test helpers — a scripted Transport (mirrors test/helpers.ts scriptedTransport)
// that replays a queue of responses/throws and records every request.
import Foundation
import XCTest
@testable import Mo1Core

enum ScriptStep {
    case ok(TransportResponse)
    case fail(Error)
}

final class ScriptedTransport: Transport, @unchecked Sendable {
    private let script: [ScriptStep]
    private let lock = NSLock()
    private var index = 0
    private(set) var calls: [TransportRequest] = []

    init(_ script: [ScriptStep]) { self.script = script }

    func send(_ request: TransportRequest) async throws -> TransportResponse {
        lock.lock()
        calls.append(request)
        let step = script[min(index, script.count - 1)]
        index += 1
        lock.unlock()
        switch step {
        case .ok(let res): return res
        case .fail(let error): throw error
        }
    }
}

private let jsonEncoder = JSONEncoder()

/// 200-ish response carrying an Encodable JSON body.
func okStep<T: Encodable>(_ body: T, status: Int = 200) -> ScriptStep {
    .ok(TransportResponse(status: status, body: try! jsonEncoder.encode(body)))
}

/// response carrying raw JSON bytes (for non-envelope / hand-built bodies).
func okRawStep(_ json: String, status: Int = 200) -> ScriptStep {
    .ok(TransportResponse(status: status, body: Data(json.utf8)))
}

func failStep(_ error: Error) -> ScriptStep {
    .fail(error)
}

/// Build a @dub/errors ErrorResponse body (mirrors helpers.ts errBody).
struct TestErrorBody: Encodable {
    struct Err: Encodable {
        let code: String
        let message: String
        let retryable: Bool
        let details: Details?
    }
    struct Details: Encodable { let retryAfterSec: Double }
    let error: Err
}

func errData(_ code: String, _ message: String? = nil, retryable: Bool = false, retryAfterSec: Double? = nil) -> Data {
    let body = TestErrorBody(error: .init(
        code: code,
        message: message ?? code,
        retryable: retryable,
        details: retryAfterSec.map { TestErrorBody.Details(retryAfterSec: $0) }
    ))
    return try! jsonEncoder.encode(body)
}

func errStep(_ code: String, _ message: String? = nil, status: Int, retryable: Bool = false, retryAfterSec: Double? = nil) -> ScriptStep {
    .ok(TransportResponse(status: status, body: errData(code, message, retryable: retryable, retryAfterSec: retryAfterSec)))
}

let noSleep: @Sendable (UInt64) async -> Void = { _ in }

func seededStore(_ token: String = "tok-1") -> InMemoryTokenStore {
    let store = InMemoryTokenStore()
    store.write(StoredSession(token: token, sessionExpiresAt: Date().timeIntervalSince1970 * 1000 + 3_600_000))
    return store
}

func sampleTask(version: Int = 3, status: TaskStatus = .inProgress) -> DubTask {
    DubTask(
        id: "task_1", eventId: "evt_1", title: "Ship it", description: nil,
        status: status, priority: .medium, assigneeId: "u1", dueAt: nil,
        origin: .internalOrigin, archivedAt: nil,
        createdAt: "2026-08-09T00:00:00Z", updatedAt: "2026-08-09T00:00:00Z", version: version
    )
}
