// EventsListViewModel — S3 events list (design §2-1). In P0 the events surface
// is the BFF home aggregate's `upcomingEvents` (there is no separate mobile
// list-events endpoint yet); this VM isolates that read so the list screen and
// its test do not depend on the Home reducer.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class EventsListViewModel: ObservableObject {
    @Published public private(set) var events: [EventSummary] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorKind: ClientErrorKind?

    private let api: MobileApi

    public init(api: MobileApi) { self.api = api }

    public var isEmpty: Bool { events.isEmpty }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await api.getHome()
            events = res.upcomingEvents
            errorKind = nil
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }
}
