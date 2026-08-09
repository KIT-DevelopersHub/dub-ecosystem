// AppSession — composition root + top-level auth routing. Owns the TokenStore
// and the ApiClient, and flips `isAuthenticated` when the ApiClient reports the
// session expired (401 -> refresh fail), routing the shell back to S1 login.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class AppSession: ObservableObject {
    @Published public var isAuthenticated: Bool
    public let tokenStore: TokenStore
    // IUO so the onSessionExpired closure can capture a fully-initialized self.
    public private(set) var api: MobileApi!

    public init(
        baseURL: String = "https://m-api.developershub.jp",
        tokenStore: TokenStore = KeychainTokenStore(),
        transport: Transport = URLSessionTransport()
    ) {
        self.tokenStore = tokenStore
        self.isAuthenticated = tokenStore.read() != nil
        self.api = MobileApiClient(ApiClientConfig(
            baseURL: baseURL,
            transport: transport,
            tokenStore: tokenStore,
            onSessionExpired: { [weak self] in
                Task { @MainActor in self?.isAuthenticated = false }
            }
        ))
    }

    public func markAuthenticated() { isAuthenticated = true }

    public func signOut() async {
        await api.logout()
        isAuthenticated = false
    }
}
