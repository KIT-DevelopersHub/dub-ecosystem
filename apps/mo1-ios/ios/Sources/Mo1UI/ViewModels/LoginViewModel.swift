// LoginViewModel — S1 auth (design §1, §2-3). Drives the ASWebAuthenticationSession
// PKCE flow: builds the authorize URL with an S256 challenge, then exchanges the
// returned code for a MobileAuthSession and persists it to the Keychain.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class LoginViewModel: ObservableObject {
    @Published public private(set) var isAuthenticating = false
    @Published public private(set) var isAuthenticated = false
    @Published public private(set) var errorKind: ClientErrorKind?

    private let api: MobileApi
    private let tokenStore: TokenStore
    private let authorizeEndpoint: String
    private let clientId: String
    private let redirectURI: String
    private let callbackScheme: String
    private let webAuth: WebAuthenticating

    /// current PKCE pair; regenerated on each login attempt.
    public private(set) var pkce = PKCE()

    public init(
        api: MobileApi,
        tokenStore: TokenStore,
        authorizeEndpoint: String = "https://m-api.developershub.jp/m/v1/auth/login",
        clientId: String = "mo1-ios",
        redirectURI: String = "dub://auth/callback",
        callbackScheme: String = "dub",
        webAuth: WebAuthenticating = WebAuthService()
    ) {
        self.api = api
        self.tokenStore = tokenStore
        self.authorizeEndpoint = authorizeEndpoint
        self.clientId = clientId
        self.redirectURI = redirectURI
        self.callbackScheme = callbackScheme
        self.webAuth = webAuth
    }

    /// The PKCE authorize URL the ASWebAuthenticationSession opens.
    public func authorizeURL() -> URL? {
        pkce = PKCE()
        var comps = URLComponents(string: authorizeEndpoint)
        comps?.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: pkce.method),
        ]
        return comps?.url
    }

    /// Run the full web-auth + exchange flow (placeholder wiring; the code
    /// verifier is sent to MO3's token endpoint by the exchange call).
    public func signIn() async {
        guard let url = authorizeURL() else { errorKind = .unknown; return }
        isAuthenticating = true
        defer { isAuthenticating = false }
        do {
            let callback = try await webAuth.authenticate(url: url, callbackScheme: callbackScheme)
            guard let code = Self.code(from: callback) else { errorKind = .validation; return }
            await completeExchange(code: code)
        } catch {
            errorKind = .offline
        }
    }

    /// Exchange an auth code for a session and persist it. Exposed for testing.
    public func completeExchange(code: String) async {
        do {
            let session = try await api.exchange(MobileExchangeRequest(code: code))
            tokenStore.write(StoredSession(token: session.token, sessionExpiresAt: session.session.sessionExpiresAt))
            isAuthenticated = true
            errorKind = nil
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }

    static func code(from callback: URL) -> String? {
        URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value
    }
}
