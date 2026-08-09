// Cache — read-only stale-while-revalidate cache (design §1 "読み取りローカル
// キャッシュ", §8-3 "オフライン書込キューは持たない"), mirrors cache.ts. The
// production app backs this with SwiftData; this is an in-memory TTL map. Values
// are display copies, never the source of truth, and logout clears everything.
import Foundation

public struct CacheEntry<T> {
    public let value: T
    /// true once past TTL: still returned (stale) but a refetch should fire.
    public let stale: Bool
}

public final class SwrCache: @unchecked Sendable {
    private struct StoredEntry { let value: Any; let storedAt: Double }
    private let ttlMs: Double
    private let now: () -> Double
    private var map: [String: StoredEntry] = [:]
    private let lock = NSLock()

    /// `now` returns milliseconds (matches Date.now() in the TS reference).
    public init(ttlMs: Double = 5 * 60 * 1000, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.ttlMs = ttlMs
        self.now = now
    }

    public func set<T>(_ key: String, _ value: T) {
        lock.lock(); defer { lock.unlock() }
        map[key] = StoredEntry(value: value, storedAt: now())
    }

    public func get<T>(_ key: String, as type: T.Type = T.self) -> CacheEntry<T>? {
        lock.lock(); defer { lock.unlock() }
        guard let e = map[key], let value = e.value as? T else { return nil }
        return CacheEntry(value: value, stale: now() - e.storedAt > ttlMs)
    }

    /// Logout / account switch: drop all display copies.
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        map.removeAll()
    }
}
