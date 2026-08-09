// ApiClient tests — the Swift counterpart of test/api-client.test.ts. Locks the
// three cross-cutting behaviours: Bearer attach, single silent refresh (1回性),
// and semi-open error + backoff.
import XCTest
@testable import Mo1Core

final class ApiClientTests: XCTestCase {
    let base = "https://m-api.developershub.jp"

    private func makeClient(_ transport: ScriptedTransport, store: TokenStore, maxRetries: Int = 2, onExpired: (@Sendable () -> Void)? = nil) -> MobileApiClient {
        MobileApiClient(ApiClientConfig(
            baseURL: base, transport: transport, tokenStore: store,
            maxRetries: maxRetries, sleep: noSleep, onSessionExpired: onExpired
        ))
    }

    func testAttachesBearerAndHitsMobilePrefix() async throws {
        let store = seededStore("abc")
        let transport = ScriptedTransport([okStep(MobileHomeResponse(upcomingEvents: [], myTasks: [], unreadCount: 0))])
        let client = makeClient(transport, store: store)

        _ = try await client.getHome()

        XCTAssertEqual(transport.calls[0].url, "\(base)/m/v1/bff/home")
        XCTAssertEqual(transport.calls[0].headers["authorization"], "Bearer abc")
    }

    func testOn401DoesOneSilentRefreshThenRetriesOnce() async throws {
        let store = seededStore("stale")
        let refreshed = MobileAuthSession(token: "fresh", session: SessionInfo(userId: "u1", client: .mobile, sessionExpiresAt: 9_999_999_999_999))
        let transport = ScriptedTransport([
            errStep("UNAUTHENTICATED", status: 401),
            okStep(refreshed),
            okStep(MobileHomeResponse(upcomingEvents: [], myTasks: [], unreadCount: 2)),
        ])
        let client = makeClient(transport, store: store)

        let home = try await client.getHome()

        XCTAssertEqual(home.unreadCount, 2)
        XCTAssertEqual(transport.calls.count, 3)
        XCTAssertEqual(transport.calls[1].url, "\(base)/m/v1/auth/refresh")
        XCTAssertEqual(transport.calls[1].headers["authorization"], "Bearer stale")
        XCTAssertEqual(transport.calls[2].headers["authorization"], "Bearer fresh")
        XCTAssertEqual(store.read()?.token, "fresh")
    }

    func testDoesNotRetryASecondTime() async {
        let store = seededStore("stale")
        let counter = ExpiryCounter()
        let refreshed = MobileAuthSession(token: "fresh", session: SessionInfo(userId: "u1", client: .mobile, sessionExpiresAt: 1))
        let transport = ScriptedTransport([
            errStep("UNAUTHENTICATED", status: 401),
            okStep(refreshed),
            errStep("UNAUTHENTICATED", status: 401),
        ])
        let client = makeClient(transport, store: store, onExpired: { counter.increment() })

        do {
            _ = try await client.getHome()
            XCTFail("expected reauth error")
        } catch let err as DubClientError {
            XCTAssertEqual(err.kind, .reauth)
        } catch {
            XCTFail("unexpected error \(error)")
        }
        XCTAssertEqual(transport.calls.count, 3)
        XCTAssertNil(store.read())
        XCTAssertEqual(counter.value, 1)
    }

    func testRoutesToLoginWhenRefreshItselfFails() async {
        let store = seededStore("stale")
        let transport = ScriptedTransport([
            errStep("UNAUTHENTICATED", status: 401),
            errStep("AUTH_REFRESH_REJECTED", status: 401),
        ])
        let client = makeClient(transport, store: store)

        do {
            _ = try await client.getHome()
            XCTFail("expected reauth error")
        } catch let err as DubClientError {
            XCTAssertEqual(err.kind, .reauth)
        } catch { XCTFail("unexpected \(error)") }
        XCTAssertNil(store.read())
    }

    func testRetriesRetryableUpstreamUpToMaxRetries() async throws {
        let store = seededStore()
        let transport = ScriptedTransport([
            errStep("UPSTREAM_UNAVAILABLE", "down", status: 502, retryable: true),
            errStep("UPSTREAM_UNAVAILABLE", "down", status: 502, retryable: true),
            okStep(MobileHomeResponse(upcomingEvents: [], myTasks: [], unreadCount: 0)),
        ])
        let client = makeClient(transport, store: store, maxRetries: 2)

        _ = try await client.getHome()
        XCTAssertEqual(transport.calls.count, 3)
    }

    func testSurfacesErrorAfterExhaustingRetries() async {
        let store = seededStore()
        let transport = ScriptedTransport([errStep("UPSTREAM_TIMEOUT", "t", status: 504, retryable: true)])
        let client = makeClient(transport, store: store, maxRetries: 2)

        do {
            _ = try await client.getHome()
            XCTFail("expected upstream error")
        } catch let err as DubClientError {
            XCTAssertEqual(err.kind, .upstream)
        } catch { XCTFail("unexpected \(error)") }
        XCTAssertEqual(transport.calls.count, 3) // initial + 2 retries
    }

    func testMapsTransportThrowToOfflineAfterRetries() async {
        let store = seededStore()
        let transport = ScriptedTransport([failStep(URLError(.notConnectedToInternet))])
        let client = makeClient(transport, store: store, maxRetries: 1)

        do {
            _ = try await client.getHome()
            XCTFail("expected offline error")
        } catch let err as DubClientError {
            XCTAssertEqual(err.kind, .offline)
        } catch { XCTFail("unexpected \(error)") }
    }

    func testDoesNotAttachBearerNorRefreshOnAnonymousExchange() async throws {
        let store = InMemoryTokenStore()
        let session = MobileAuthSession(token: "t", session: SessionInfo(userId: "u1", client: .mobile, sessionExpiresAt: 1))
        let transport = ScriptedTransport([okStep(session)])
        let client = makeClient(transport, store: store)

        _ = try await client.exchange(MobileExchangeRequest(code: "auth-code"))
        XCTAssertEqual(transport.calls[0].url, "\(base)/m/v1/auth/exchange")
        XCTAssertNil(transport.calls[0].headers["authorization"])
    }

    func testLogoutClearsKeychainEvenIfServerCallFails() async {
        let store = seededStore("bye")
        let transport = ScriptedTransport([failStep(URLError(.notConnectedToInternet))])
        let client = makeClient(transport, store: store, maxRetries: 0)

        await client.logout()
        XCTAssertNil(store.read())
    }

    func testBuildsTaskListQueryStrings() async throws {
        let store = seededStore()
        let transport = ScriptedTransport([okStep(ListTasksResponse(items: [], nextCursor: nil))])
        let client = makeClient(transport, store: store)

        _ = try await client.listTasks(ListTasksQuery(limit: 20, assigneeId: "me"))
        let comps = URLComponents(string: transport.calls[0].url)!
        XCTAssertEqual(comps.path, "/m/v1/tasks")
        XCTAssertEqual(comps.queryItems?.first(where: { $0.name == "assigneeId" })?.value, "me")
        XCTAssertEqual(comps.queryItems?.first(where: { $0.name == "limit" })?.value, "20")
    }

    func testPatchTaskSendsVersionForOptimisticLocking() async throws {
        let store = seededStore()
        let updated = sampleTask(version: 5, status: .done)
        let transport = ScriptedTransport([okStep(updated)])
        let client = makeClient(transport, store: store)

        _ = try await client.patchTask("task_1", UpdateTaskRequest(version: 4, status: .done))
        XCTAssertEqual(transport.calls[0].method, .PATCH)
        let sentBody = try JSONDecoder().decode(UpdateTaskRequest.self, from: transport.calls[0].body ?? Data())
        XCTAssertEqual(sentBody.version, 4)
        XCTAssertEqual(sentBody.status, .done)
    }

    func testThrowsConflictOn409VersionMismatch() async {
        let store = seededStore()
        let transport = ScriptedTransport([errStep("TASK_VERSION_CONFLICT", "stale", status: 409)])
        let client = makeClient(transport, store: store)

        do {
            _ = try await client.patchTask("t1", UpdateTaskRequest(version: 1, status: .done))
            XCTFail("expected conflict")
        } catch let err as DubClientError {
            XCTAssertEqual(err.kind, .conflict)
            XCTAssertEqual(err.code, "TASK_VERSION_CONFLICT")
        } catch { XCTFail("unexpected \(error)") }
    }
}

/// Thread-safe counter for the onSessionExpired callback assertion.
final class ExpiryCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}
