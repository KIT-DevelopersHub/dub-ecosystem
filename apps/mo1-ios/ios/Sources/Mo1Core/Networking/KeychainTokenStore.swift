// KeychainTokenStore — the production TokenStore backed by the system Keychain
// (Security framework). Stores the bearer token as a generic-password item and
// the epoch-ms expiry in its `service` companion key. Available on iOS + macOS.
import Foundation
import Security

public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    private let account: String

    public init(service: String = "jp.developershub.mo1.session", account: String = "bearer") {
        self.service = service
        self.account = account
    }

    private struct Persisted: Codable { let token: String; let sessionExpiresAt: EpochMs }

    public func read() -> StoredSession? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let p = try? JSONDecoder().decode(Persisted.self, from: data)
        else { return nil }
        return StoredSession(token: p.token, sessionExpiresAt: p.sessionExpiresAt)
    }

    public func write(_ session: StoredSession) {
        guard let data = try? JSONEncoder().encode(Persisted(token: session.token, sessionExpiresAt: session.sessionExpiresAt)) else { return }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Upsert: try update first, fall back to add.
        let attrs: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(base as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
