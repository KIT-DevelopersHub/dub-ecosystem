// EventDetailViewModel — S3/S4 event overview (design §2-1). Loads the frozen
// MobileEventOverviewResponse (event summary + the caller's capability set) so
// the view can render read-only vs editable UI strictly from server-granted
// capabilities (design §6 — the client never decides authorization).
import Foundation
import Combine
import Mo1Core

@MainActor
public final class EventDetailViewModel: ObservableObject {
    @Published public private(set) var event: EventSummary?
    @Published public private(set) var capabilities: [PermissionKey] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorKind: ClientErrorKind?

    private let api: MobileApi
    private let eventId: Ids.EventId

    public init(api: MobileApi, eventId: Ids.EventId) {
        self.api = api
        self.eventId = eventId
    }

    /// Can the signed-in user edit this event / its actions? (default deny.)
    public var canEdit: Bool { canEditEvent(capabilities) }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await api.getEventOverview(eventId)
            event = res.event
            capabilities = res.capabilities
            errorKind = nil
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }
}
