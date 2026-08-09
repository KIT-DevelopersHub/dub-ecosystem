// HomeViewModel tests — S2 load success + error surfacing (design §2-1).
import XCTest
import Mo1Core
@testable import Mo1UI

@MainActor
final class HomeViewModelTests: XCTestCase {
    func testLoadReducesResponseIntoState() async {
        let home = MobileHomeResponse(
            upcomingEvents: [EventSummary(id: "evt_1", title: "Conf", phase: .planning, startsAt: nil)],
            myTasks: [
                TaskSummary(id: "a", title: "A", status: .todo, assigneeId: "u1"),
                TaskSummary(id: "b", title: "B", status: .done, assigneeId: "u1"),
            ],
            unreadCount: 3
        )
        let store = InMemoryTokenStore()
        store.write(StoredSession(token: "t", sessionExpiresAt: 1))
        let vm = HomeViewModel(api: makeClient([jsonStep(home)], store: store))

        await vm.load()

        XCTAssertEqual(vm.state.todayTasks.map { $0.id }, ["a"]) // done dropped
        XCTAssertEqual(vm.state.unreadCount, 3)
        XCTAssertTrue(vm.state.hasUnread)
        XCTAssertFalse(vm.state.isEmpty)
        XCTAssertNil(vm.errorKind)
        XCTAssertFalse(vm.isLoading)
    }

    func testLoadSurfacesUpstreamErrorKind() async {
        let store = InMemoryTokenStore()
        store.write(StoredSession(token: "t", sessionExpiresAt: 1))
        // three 502s (initial + 2 retries) exhaust the budget then surface.
        let vm = HomeViewModel(api: makeClient([errorStep("UPSTREAM_UNAVAILABLE", status: 502, retryable: true)], store: store))

        await vm.load()

        XCTAssertEqual(vm.errorKind, .upstream)
    }
}
