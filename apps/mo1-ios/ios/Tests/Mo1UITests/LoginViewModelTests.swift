// LoginViewModel tests — S1 exchange persists the session; signIn drives the
// web-auth stub through to a stored token; authorize URL carries the PKCE S256
// challenge (design §1, §2-3).
import XCTest
import Mo1Core
@testable import Mo1UI

@MainActor
final class LoginViewModelTests: XCTestCase {
    func testCompleteExchangePersistsSessionAndAuthenticates() async {
        let store = InMemoryTokenStore()
        let session = MobileAuthSession(token: "sess-token", session: SessionInfo(userId: "u1", client: .mobile, sessionExpiresAt: 123))
        let vm = LoginViewModel(api: makeClient([jsonStep(session)], store: store), tokenStore: store)

        await vm.completeExchange(code: "auth-code")

        XCTAssertTrue(vm.isAuthenticated)
        XCTAssertEqual(store.read()?.token, "sess-token")
        XCTAssertEqual(store.read()?.sessionExpiresAt, 123)
        XCTAssertNil(vm.errorKind)
    }

    func testExchangeErrorSurfacesKindAndDoesNotAuthenticate() async {
        let store = InMemoryTokenStore()
        let vm = LoginViewModel(api: makeClient([errorStep("VALIDATION_FAILED", status: 400)], store: store), tokenStore: store)

        await vm.completeExchange(code: "bad-code")

        XCTAssertFalse(vm.isAuthenticated)
        XCTAssertEqual(vm.errorKind, .validation)
        XCTAssertNil(store.read())
    }

    func testSignInRunsWebAuthThenExchange() async {
        let store = InMemoryTokenStore()
        let session = MobileAuthSession(token: "web-token", session: SessionInfo(userId: "u1", client: .mobile, sessionExpiresAt: 9))
        let webAuth = StubWebAuth(.success(URL(string: "dub://auth/callback?code=xyz")!))
        let vm = LoginViewModel(api: makeClient([jsonStep(session)], store: store), tokenStore: store, webAuth: webAuth)

        await vm.signIn()

        XCTAssertTrue(vm.isAuthenticated)
        XCTAssertEqual(store.read()?.token, "web-token")
    }

    func testAuthorizeURLCarriesPkceChallenge() {
        let store = InMemoryTokenStore()
        let vm = LoginViewModel(api: makeClient([], store: store), tokenStore: store)

        let url = vm.authorizeURL()
        let items = URLComponents(url: url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "code_challenge_method" })?.value, "S256")
        XCTAssertEqual(items.first(where: { $0.name == "code_challenge" })?.value, vm.pkce.challenge)
        XCTAssertFalse(vm.pkce.challenge.isEmpty)
    }
}
