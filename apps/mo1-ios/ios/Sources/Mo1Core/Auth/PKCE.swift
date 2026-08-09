// PKCE — RFC 7636 code_verifier / code_challenge (S256) generation used by the
// ASWebAuthenticationSession login flow (design §2-3). Kept in Core (pure,
// CryptoKit) so the challenge derivation is unit-testable off-device.
import Foundation
import CryptoKit

public struct PKCE: Equatable, Sendable {
    public let verifier: String
    public let challenge: String
    public let method = "S256"

    /// Generate a fresh verifier + its S256 challenge.
    public init() {
        self.verifier = PKCE.randomVerifier()
        self.challenge = PKCE.challenge(for: verifier)
    }

    /// Deterministic init for tests / replay of a stored verifier.
    public init(verifier: String) {
        self.verifier = verifier
        self.challenge = PKCE.challenge(for: verifier)
    }

    /// base64url(SHA256(ascii(verifier))) with no padding (RFC 7636 §4.2).
    public static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URL(Data(digest))
    }

    private static func randomVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return base64URL(Data(bytes))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
