// InboxViewModel tests — first-page load, unread counting, and cursor paging.
import XCTest
import Mo1Core
@testable import Mo1UI

@MainActor
final class InboxViewModelTests: XCTestCase {
    private func item(_ id: String, read: Bool) -> InboxItem {
        InboxItem(id: id, type: "task.assigned", title: id, body: "b", readAt: read ? "2026-08-09T00:00:00Z" : nil,
                  createdAt: "2026-08-09T00:00:00Z", resourceType: nil, resourceId: nil)
    }

    func testLoadCountsUnread() async {
        let page = Paginated<InboxItem>(items: [item("n1", read: false), item("n2", read: true), item("n3", read: false)], nextCursor: "c2")
        let vm = InboxViewModel(api: makeClient([jsonStep(page)], store: seededUIStore()))

        await vm.load()

        XCTAssertEqual(vm.items.count, 3)
        XCTAssertEqual(vm.unreadCount, 2)
        XCTAssertEqual(vm.nextCursor, "c2")
    }

    func testLoadMoreAppendsNextPage() async {
        let page1 = Paginated<InboxItem>(items: [item("n1", read: false)], nextCursor: "c2")
        let page2 = Paginated<InboxItem>(items: [item("n2", read: false)], nextCursor: nil)
        let vm = InboxViewModel(api: makeClient([jsonStep(page1), jsonStep(page2)], store: seededUIStore()))

        await vm.load()
        await vm.loadMore()

        XCTAssertEqual(vm.items.map { $0.id }, ["n1", "n2"])
        XCTAssertNil(vm.nextCursor)
    }

    func testLoadMoreNoOpAtEnd() async {
        let page = Paginated<InboxItem>(items: [item("n1", read: false)], nextCursor: nil)
        let vm = InboxViewModel(api: makeClient([jsonStep(page)], store: seededUIStore()))

        await vm.load()
        await vm.loadMore() // nextCursor nil -> no network call, no crash

        XCTAssertEqual(vm.items.count, 1)
    }
}
