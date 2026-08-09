// Mo1App — @main entry. Builds the AppSession composition root (Keychain token
// store + URLSession transport over m-api.developershub.jp) and renders RootView.
import SwiftUI
import Mo1UI

@main
struct Mo1App: App {
    @StateObject private var session = AppSession()

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
        }
    }
}
