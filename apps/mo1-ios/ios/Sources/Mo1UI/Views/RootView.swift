// RootView — S1/authenticated-shell switch driven by AppSession.isAuthenticated.
// Once signed in it presents the tab shell (Home, Events, Inbox, Settings); the
// S4/S6/S8 screens are reached by drilling in from Events. The single entry the
// app's WindowGroup renders.
import SwiftUI
import Mo1Core

public struct RootView: View {
    @ObservedObject private var session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public var body: some View {
        if session.isAuthenticated {
            AppShellView(session: session)
        } else {
            LoginView(
                vm: LoginViewModel(api: session.api, tokenStore: session.tokenStore),
                onAuthenticated: { userId in session.markAuthenticated(userId: userId) }
            )
        }
    }
}

/// The signed-in tab shell (design §5 navigation model).
public struct AppShellView: View {
    @ObservedObject private var session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public var body: some View {
        TabView {
            HomeView(api: session.api, onSignOut: {
                Task { await session.signOut() }
            })
            .tabItem { Label("Home", systemImage: "house") }

            EventsListView(api: session.api)
                .tabItem { Label("Events", systemImage: "calendar") }

            InboxView(api: session.api)
                .tabItem { Label("Inbox", systemImage: "bell") }

            SettingsView(session: session)
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
