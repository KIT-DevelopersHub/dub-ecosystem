// TokenStore — Keychain abstraction (design §1 "Bearer トークン・Keychain 保管",
// mirrors token-store.ts). The production app backs this with the iOS Keychain
// (see KeychainTokenStore); the in-memory impl is used by tests. Logout MUST
// clear everything (design §3).
import Foundation

public struct StoredSession: Equatable, Sendable {
    /// Single opaque bearer token (theme8).
    public var token: String
    /// epoch-ms session expiry mirror (auth.SessionInfo.sessionExpiresAt).
    public var sessionExpiresAt: EpochMs
    public init(token: String, sessionExpiresAt: EpochMs) {
        self.token = token; self.sessionExpiresAt = sessionExpiresAt
    }
}

public protocol TokenStore: AnyObject, Sendable {
    func read() -> StoredSession?
    func write(_ session: StoredSession)
    func clear()
}

/// In-memory reference impl for tests (thread-safe via a lock).
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private var session: StoredSession?
    private let lock = NSLock()
    public init() {}

    public func read() -> StoredSession? {
        lock.lock(); defer { lock.unlock() }
        return session
    }
    public func write(_ session: StoredSession) {
        lock.lock(); defer { lock.unlock() }
        self.session = session
    }
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        session = nil
    }
}
