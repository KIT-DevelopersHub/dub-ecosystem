// Cache + TokenStore tests — Swift counterpart of test/cache.test.ts
// (design §1 read cache, §3 logout clears).
import XCTest
@testable import Mo1Core

final class CacheTests: XCTestCase {
    struct Home: Equatable { let unread: Int }

    func testReturnsFreshThenStaleAsTimePasses() {
        var now: Double = 1_000
        let cache = SwrCache(ttlMs: 100, now: { now })
        cache.set("home", Home(unread: 2))

        let fresh = cache.get("home", as: Home.self)
        XCTAssertEqual(fresh?.value, Home(unread: 2))
        XCTAssertEqual(fresh?.stale, false)

        now = 1_200 // past ttl
        let stale = cache.get("home", as: Home.self)
        XCTAssertEqual(stale?.stale, true)
        XCTAssertEqual(stale?.value, Home(unread: 2)) // still returned
    }

    func testReturnsNilForMissingKey() {
        XCTAssertNil(SwrCache().get("nope", as: Int.self))
    }

    func testClearDropsAllDisplayCopies() {
        let cache = SwrCache()
        cache.set("a", 1)
        cache.clear()
        XCTAssertNil(cache.get("a", as: Int.self))
    }

    func testTokenStoreClearRemovesSession() {
        let store = InMemoryTokenStore()
        store.write(StoredSession(token: "t", sessionExpiresAt: 1))
        XCTAssertNotNil(store.read())
        store.clear()
        XCTAssertNil(store.read())
    }
}
