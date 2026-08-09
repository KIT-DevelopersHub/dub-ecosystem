// PKCE tests — RFC 7636 S256 challenge derivation (design §2-3 login flow).
import XCTest
@testable import Mo1Core

final class PKCETests: XCTestCase {
    func testS256ChallengeMatchesRfc7636AppendixBVector() {
        // RFC 7636 Appendix B canonical example.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        XCTAssertEqual(PKCE.challenge(for: verifier), expected)
    }

    func testChallengeIsDeterministicForAGivenVerifier() {
        let pkce = PKCE(verifier: "fixed-verifier-value")
        XCTAssertEqual(pkce.challenge, PKCE.challenge(for: "fixed-verifier-value"))
        XCTAssertEqual(pkce.method, "S256")
    }

    func testGeneratedVerifierIsUrlSafeAndUnpadded() {
        let pkce = PKCE()
        XCTAssertFalse(pkce.verifier.contains("="))
        XCTAssertFalse(pkce.verifier.contains("+"))
        XCTAssertFalse(pkce.verifier.contains("/"))
        XCTAssertFalse(pkce.challenge.isEmpty)
    }
}
