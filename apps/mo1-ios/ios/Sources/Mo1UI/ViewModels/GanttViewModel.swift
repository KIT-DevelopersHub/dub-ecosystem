// GanttViewModel — S6 Gantt screen (design §2-1 S6). Loads the frozen
// GanttChartDTO via the ApiClient and folds it into the shared, dependency-
// ordered GanttViewData. Zoom + row collapse are local view state (the persist
// PUT lands with the gantt-view endpoint in a later wave); changing either
// re-projects the cached chart without a refetch.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class GanttViewModel: ObservableObject {
    @Published public private(set) var data: GanttViewData?
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorKind: ClientErrorKind?
    @Published public private(set) var zoom: GanttZoom = .week
    @Published public private(set) var collapsedTaskIds: Set<Ids.TaskId> = []

    private let api: MobileApi
    private let eventId: Ids.EventId
    private var chart: GanttChartDTO?

    public init(api: MobileApi, eventId: Ids.EventId) {
        self.api = api
        self.eventId = eventId
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let dto = try await api.getGantt(GetGanttQuery(eventId: eventId))
            chart = dto
            errorKind = nil
            rebuild()
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }

    public func setZoom(_ next: GanttZoom) {
        zoom = next
        rebuild()
    }

    public func toggleCollapse(_ taskId: Ids.TaskId) {
        if collapsedTaskIds.contains(taskId) { collapsedTaskIds.remove(taskId) } else { collapsedTaskIds.insert(taskId) }
        rebuild()
    }

    /// Body to persist the current view state (zoom + collapsed rows).
    public func putRequest() -> PutGanttViewRequest {
        toPutGanttViewRequest(zoom: zoom, collapsedTaskIds: Array(collapsedTaskIds))
    }

    private func rebuild() {
        guard let chart else { return }
        data = buildGanttViewData(chart, options: GanttViewOptions(zoom: zoom, collapsedTaskIds: Array(collapsedTaskIds)))
    }
}
