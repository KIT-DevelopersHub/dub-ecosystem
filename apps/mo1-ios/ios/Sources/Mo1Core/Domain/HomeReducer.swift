// HomeReducer — HomeView (S2) view-state reducer over MobileHomeResponse
// (design §2-1), mirrors home.ts. Surfaces an "empty" flag and a bounded task
// preview so the ViewModel and its tests agree on the exact shape.
import Foundation

public struct HomeViewState: Equatable {
    public var upcomingEvents: [EventSummary]
    /// open tasks first (todo/in_progress/blocked), capped for the home preview.
    public var todayTasks: [TaskSummary]
    public var unreadCount: Int
    public var hasUnread: Bool
    public var isEmpty: Bool

    public init(upcomingEvents: [EventSummary] = [], todayTasks: [TaskSummary] = [], unreadCount: Int = 0, hasUnread: Bool = false, isEmpty: Bool = true) {
        self.upcomingEvents = upcomingEvents
        self.todayTasks = todayTasks
        self.unreadCount = unreadCount
        self.hasUnread = hasUnread
        self.isEmpty = isEmpty
    }
}

private let OPEN_STATUSES: Set<TaskStatus> = [.todo, .inProgress, .blocked]

public func buildHomeViewState(_ res: MobileHomeResponse, taskPreviewLimit: Int = 5) -> HomeViewState {
    let open = res.myTasks.filter { OPEN_STATUSES.contains($0.status) }
    let todayTasks = Array(open.prefix(max(0, taskPreviewLimit)))
    return HomeViewState(
        upcomingEvents: res.upcomingEvents,
        todayTasks: todayTasks,
        unreadCount: res.unreadCount,
        hasUnread: res.unreadCount > 0,
        isEmpty: res.upcomingEvents.isEmpty && open.isEmpty
    )
}
