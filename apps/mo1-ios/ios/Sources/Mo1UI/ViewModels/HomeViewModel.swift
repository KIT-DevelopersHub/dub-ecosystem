// HomeViewModel — S2 Home screen (design §2-1). Loads MobileHomeResponse via the
// ApiClient and reduces it to a HomeViewState with the shared pure reducer. The
// reauth kind is surfaced so AppShell can route back to S1 login.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class HomeViewModel: ObservableObject {
    @Published public private(set) var state = HomeViewState()
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorKind: ClientErrorKind?

    private let api: MobileApi

    public init(api: MobileApi) { self.api = api }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await api.getHome()
            state = buildHomeViewState(res)
            errorKind = nil
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }
}
