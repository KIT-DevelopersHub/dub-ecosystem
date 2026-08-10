// SettingsView — S9 preferences (design §5). P0 surfaces the signed-in identity,
// the push-notification registration state for this device, and sign-out (which
// clears the Keychain and routes back to S1). Live APNs registration + a full
// device-management list land with the 9-E push wave.
import SwiftUI
import Mo1Core

public struct SettingsView: View {
    @ObservedObject private var session: AppSession
    @State private var signingOut = false

    public init(session: AppSession) {
        self.session = session
    }

    public var body: some View {
        NavigationStack {
            List {
                Section("Account") {
                    LabeledContent("User", value: session.currentUserId ?? "—")
                }
                Section("Notifications") {
                    LabeledContent("Push", value: "Not registered")
                    Text("APNs registration lands in a later update.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Button(role: .destructive) {
                        Task {
                            signingOut = true
                            await session.signOut()
                            signingOut = false
                        }
                    } label: {
                        HStack {
                            if signingOut { ProgressView() }
                            Text("Sign out")
                        }
                    }
                    .disabled(signingOut)
                }
            }
            .navigationTitle("Settings")
        }
    }
}
