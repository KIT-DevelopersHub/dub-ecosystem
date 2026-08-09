// LoginView — S1 login (design §5 S1). A single "Sign in with Google" action
// kicks the ASWebAuthenticationSession PKCE flow via LoginViewModel. On success
// it notifies the AppSession, which swaps in the Home tab.
import SwiftUI
import Mo1Core

public struct LoginView: View {
    @StateObject private var vm: LoginViewModel
    private let onAuthenticated: () -> Void

    public init(vm: LoginViewModel, onAuthenticated: @escaping () -> Void) {
        _vm = StateObject(wrappedValue: vm)
        self.onAuthenticated = onAuthenticated
    }

    public var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("DevelopersHub")
                .font(.largeTitle.bold())
            Text("Sign in to view your events and tasks")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                Task { await vm.signIn() }
            } label: {
                HStack {
                    if vm.isAuthenticating { ProgressView() }
                    Text("Sign in with Google")
                }
                .frame(maxWidth: .infinity)
                .padding()
            }
            .buttonStyle(.borderedProminent)
            .disabled(vm.isAuthenticating)

            if let kind = vm.errorKind {
                Text("Sign-in failed (\(kind.rawValue)). Please try again.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Spacer()
        }
        .padding()
        .onChange(of: vm.isAuthenticated) { _, authenticated in
            if authenticated { onAuthenticated() }
        }
    }
}
