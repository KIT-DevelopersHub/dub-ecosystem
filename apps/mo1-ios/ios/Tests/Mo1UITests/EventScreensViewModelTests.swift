// Event screen ViewModel tests — S3 list (home aggregate) + S4 detail
// (capabilities gating).
import XCTest
import Mo1Core
@testable import Mo1UI

@MainActor
final class EventScreensViewModelTests: XCTestCase {
    func testEventsListReadsUpcomingEvents() async {
        let home = MobileHomeResponse(
            upcomingEvents: [
                EventSummary(id: "evt_1", title: "Conf", phase: .planning, startsAt: nil),
                EventSummary(id: "evt_2", title: "Hack", phase: .open, startsAt: "2026-09-01T00:00:00Z"),
            ],
            myTasks: [], unreadCount: 0)
        let vm = EventsListViewModel(api: makeClient([jsonStep(home)], store: seededUIStore()))

        await vm.load()

        XCTAssertEqual(vm.events.map { $0.id }, ["evt_1", "evt_2"])
        XCTAssertFalse(vm.isEmpty)
    }

    func testEventDetailExposesCapabilityGate() async {
        let overview = MobileEventOverviewResponse(
            event: EventSummary(id: "evt_1", title: "Conf", phase: .live, startsAt: nil),
            capabilities: [.eventRead, .eventWrite])
        let vm = EventDetailViewModel(api: makeClient([jsonStep(overview)], store: seededUIStore()), eventId: "evt_1")

        await vm.load()

        XCTAssertEqual(vm.event?.title, "Conf")
        XCTAssertTrue(vm.canEdit)
    }

    func testEventDetailReadOnlyWhenNoWriteCapability() async {
        let overview = MobileEventOverviewResponse(
            event: EventSummary(id: "evt_1", title: "Conf", phase: .live, startsAt: nil),
            capabilities: [.eventRead])
        let vm = EventDetailViewModel(api: makeClient([jsonStep(overview)], store: seededUIStore()), eventId: "evt_1")

        await vm.load()

        XCTAssertFalse(vm.canEdit)
    }
}
