// WebAuthService — ASWebAuthenticationSession wrapper for the PKCE login flow
// (design §2-3). Behind the `WebAuthenticating` protocol so LoginViewModel can
// be unit-tested with a stub that returns a canned callback URL. Universal Links
// are the production callback; this placeholder uses the `dub://` custom scheme.
import Foundation
import AuthenticationServices
#if canImport(UIKit)
import UIKit
#endif

public protocol WebAuthenticating {
    /// Present the authorize URL and resolve the redirect callback URL.
    @MainActor func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

public final class WebAuthService: NSObject, WebAuthenticating, ASWebAuthenticationPresentationContextProviding {
    public override init() { super.init() }

    @MainActor
    public func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callback, error in
                if let callback {
                    cont.resume(returning: callback)
                } else {
                    cont.resume(throwing: error ?? URLError(.userCancelledAuthentication))
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            session.start()
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(iOS)
        let anchor = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        return anchor ?? ASPresentationAnchor()
        #else
        return ASPresentationAnchor()
        #endif
    }
}
