// GanttViewModel tests — S6 load + local zoom/collapse re-projection.
import XCTest
import Mo1Core
@testable import Mo1UI

@MainActor
final class GanttViewModelTests: XCTestCase {
    private func chart() -> GanttChartDTO {
        GanttChartDTO(
            eventId: "evt_1",
            rows: [
                GanttRow(taskId: "b", title: "B", startsAt: "2026-08-03T00:00:00Z", endsAt: "2026-08-05T00:00:00Z", progressPercent: 0, assigneeId: nil),
                GanttRow(taskId: "a", title: "A", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-03T00:00:00Z", progressPercent: 100, assigneeId: "u1"),
            ],
            dependencies: [GanttDependencyLine(id: "a->b", fromTaskId: "a", toTaskId: "b")])
    }

    func testLoadBuildsDependencyOrderedRows() async {
        let store = seededUIStore()
        let vm = GanttViewModel(api: makeClient([jsonStep(chart())], store: store), eventId: "evt_1")

        await vm.load()

        XCTAssertEqual(vm.data?.rows.map { $0.taskId }, ["a", "b"])
        XCTAssertEqual(vm.zoom, .week)
        XCTAssertNil(vm.errorKind)
    }

    func testSetZoomAndCollapseReprojectWithoutRefetch() async {
        let store = seededUIStore()
        // single transport response: a second network call would run off the end.
        let vm = GanttViewModel(api: makeClient([jsonStep(chart())], store: store), eventId: "evt_1")
        await vm.load()

        vm.setZoom(.day)
        XCTAssertEqual(vm.data?.zoom, .day)

        vm.toggleCollapse("a")
        XCTAssertTrue(vm.data?.rows.first { $0.taskId == "a" }?.collapsed ?? false)
        vm.toggleCollapse("a")
        XCTAssertFalse(vm.data?.rows.first { $0.taskId == "a" }?.collapsed ?? true)

        XCTAssertEqual(vm.putRequest().zoom, .day)
    }

    func testLoadSurfacesErrorKind() async {
        let store = seededUIStore()
        let vm = GanttViewModel(api: makeClient([errorStep("FORBIDDEN", status: 403)], store: store), eventId: "evt_1")
        await vm.load()
        XCTAssertEqual(vm.errorKind, .forbidden)
        XCTAssertNil(vm.data)
    }
}
