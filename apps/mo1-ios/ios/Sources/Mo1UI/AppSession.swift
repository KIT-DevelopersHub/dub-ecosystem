// AppSession — composition root + top-level auth routing. Owns the TokenStore
// and the ApiClient, and flips `isAuthenticated` when the ApiClient reports the
// session expired (401 -> refresh fail), routing the shell back to S1 login.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class AppSession: ObservableObject {
    @Published public var isAuthenticated: Bool
    /// userId of the signed-in session (set at login; nil after sign-out). Used
    /// to left/right-align own chat messages and label Settings.
    @Published public private(set) var currentUserId: String?
    /// injected DO-direct chat socket factory (real URLSessionWebSocket by
    /// default; tests/previews swap in a stub).
    public let chatSocketFactory: ChatSocketFactory
    public let tokenStore: TokenStore
    // IUO so the onSessionExpired closure can capture a fully-initialized self.
    public private(set) var api: MobileApi!

    public init(
        baseURL: String = "https://m-api.developershub.jp",
        tokenStore: TokenStore = KeychainTokenStore(),
        transport: Transport = URLSessionTransport(),
        chatSocketFactory: ChatSocketFactory = URLSessionChatSocketFactory()
    ) {
        self.tokenStore = tokenStore
        self.chatSocketFactory = chatSocketFactory
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

    public func markAuthenticated(userId: String? = nil) {
        currentUserId = userId
        isAuthenticated = true
    }

    public func signOut() async {
        await api.logout()
        currentUserId = nil
        isAuthenticated = false
    }
}
