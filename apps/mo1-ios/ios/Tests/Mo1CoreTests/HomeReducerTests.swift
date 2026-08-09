// Home reducer tests — Swift counterpart of test/home.test.ts (design §2-1 S2).
import XCTest
@testable import Mo1Core

final class HomeReducerTests: XCTestCase {
    private func summary(_ id: String, _ status: TaskStatus) -> TaskSummary {
        TaskSummary(id: id, title: id, status: status, assigneeId: "u1")
    }

    func testKeepsOnlyOpenTasksInPreviewAndCaps() {
        let res = MobileHomeResponse(
            upcomingEvents: [EventSummary(id: "evt_1", title: "Conf", phase: .planning, startsAt: nil)],
            myTasks: [summary("a", .todo), summary("b", .done), summary("c", .inProgress), summary("d", .blocked), summary("e", .cancelled)],
            unreadCount: 4
        )
        let state = buildHomeViewState(res, taskPreviewLimit: 2)
        XCTAssertEqual(state.todayTasks.map { $0.id }, ["a", "c"]) // done/cancelled dropped, capped at 2
        XCTAssertTrue(state.hasUnread)
        XCTAssertFalse(state.isEmpty)
    }

    func testIsEmptyWhenNoEventsAndNoOpenTasks() {
        let res = MobileHomeResponse(upcomingEvents: [], myTasks: [summary("a", .done)], unreadCount: 0)
        let state = buildHomeViewState(res)
        XCTAssertTrue(state.isEmpty)
        XCTAssertFalse(state.hasUnread)
    }
}
