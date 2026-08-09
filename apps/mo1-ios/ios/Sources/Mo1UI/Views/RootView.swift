// RootView — S1/S2 switch driven by AppSession.isAuthenticated. The single
// entry the app's WindowGroup renders.
import SwiftUI
import Mo1Core

public struct RootView: View {
    @ObservedObject private var session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public var body: some View {
        if session.isAuthenticated {
            HomeView(api: session.api, onSignOut: {
                Task { await session.signOut() }
            })
        } else {
            LoginView(
                vm: LoginViewModel(api: session.api, tokenStore: session.tokenStore),
                onAuthenticated: { session.markAuthenticated() }
            )
        }
    }
}
