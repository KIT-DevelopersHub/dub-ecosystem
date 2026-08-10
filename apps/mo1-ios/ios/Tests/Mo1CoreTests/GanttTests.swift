// Gantt tests — Swift counterpart of test/gantt.test.ts (design §2-1 S6):
// date math, dependency ordering + cycle fallback, and the S6 view-model.
import XCTest
@testable import Mo1Core

final class GanttTests: XCTestCase {
    private func task(_ id: String, _ start: String?, _ end: String?) -> GanttCalcTask {
        GanttCalcTask(id: id, startsAt: start, endsAt: end, durationDays: 0)
    }
    private func dep(_ taskId: String, on dependsOnId: String) -> GanttCalcDependency {
        GanttCalcDependency(taskId: taskId, dependsOnId: dependsOnId)
    }

    // ---- date math ----------------------------------------------------------

    func testDayDiffCountsWholeDaysAndCollapsesBadInput() {
        XCTAssertEqual(dayDiff("2026-08-01T00:00:00Z", "2026-08-04T00:00:00Z"), 3)
        XCTAssertEqual(dayDiff("2026-08-04T00:00:00Z", "2026-08-01T00:00:00Z"), -3)
        XCTAssertEqual(dayDiff("not-a-date", "2026-08-01T00:00:00Z"), 0)
    }

    func testDateRangeSpansEarliestToLatestSkippingUnscheduled() {
        let r = dateRange([
            task("a", "2026-08-03T00:00:00Z", "2026-08-05T00:00:00Z"),
            task("b", "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"),
            task("c", nil, nil),
        ])
        XCTAssertEqual(r.start, "2026-08-01T00:00:00Z")
        XCTAssertEqual(r.end, "2026-08-05T00:00:00Z")
        XCTAssertEqual(r.totalDays, 4)
    }

    func testDateRangeNullWhenNothingScheduled() {
        let r = dateRange([task("a", nil, nil)])
        XCTAssertNil(r.start)
        XCTAssertNil(r.end)
        XCTAssertEqual(r.totalDays, 0)
    }

    // ---- dependency ordering ------------------------------------------------

    func testOrdersPredecessorsBeforeSuccessorsAndAssignsDepth() {
        // c depends on b, b depends on a  =>  a, b, c with depth 0,1,2
        let res = dependencyOrder(
            [task("c", nil, nil), task("a", nil, nil), task("b", nil, nil)],
            [dep("c", on: "b"), dep("b", on: "a")])
        XCTAssertEqual(res.order, ["a", "b", "c"])
        XCTAssertEqual(res.depth["a"], 0)
        XCTAssertEqual(res.depth["b"], 1)
        XCTAssertEqual(res.depth["c"], 2)
        XCTAssertFalse(res.hasCycle)
    }

    func testKeepsSourceOrderAmongIndependentRows() {
        let res = dependencyOrder([task("x", nil, nil), task("y", nil, nil), task("z", nil, nil)], [])
        XCTAssertEqual(res.order, ["x", "y", "z"])
        XCTAssertFalse(res.hasCycle)
    }

    func testIgnoresDependenciesReferencingUnknownTasks() {
        let res = dependencyOrder([task("a", nil, nil)], [dep("a", on: "ghost"), dep("ghost", on: "a")])
        XCTAssertEqual(res.order, ["a"])
        XCTAssertFalse(res.hasCycle)
    }

    func testFlagsCycleAndFallsBackToSourceOrder() {
        // a -> b -> a is a cycle; both remain, source order, hasCycle set.
        let res = dependencyOrder([task("a", nil, nil), task("b", nil, nil)], [dep("b", on: "a"), dep("a", on: "b")])
        XCTAssertTrue(res.hasCycle)
        XCTAssertEqual(Set(res.order), ["a", "b"])
        XCTAssertEqual(res.order.count, 2)
    }

    // ---- S6 view-model ------------------------------------------------------

    private func chart() -> GanttChartDTO {
        GanttChartDTO(
            eventId: "evt_1",
            rows: [
                GanttRow(taskId: "c", title: "C", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-07T00:00:00Z", progressPercent: 0, assigneeId: nil),
                GanttRow(taskId: "a", title: "A", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-03T00:00:00Z", progressPercent: 100, assigneeId: "u1"),
                GanttRow(taskId: "b", title: "B", startsAt: "2026-08-03T00:00:00Z", endsAt: "2026-08-05T00:00:00Z", progressPercent: 0, assigneeId: nil),
            ],
            dependencies: [
                GanttDependencyLine(id: "a->b", fromTaskId: "a", toTaskId: "b"),
                GanttDependencyLine(id: "b->c", fromTaskId: "b", toTaskId: "c"),
            ])
    }

    func testOrdersRowsByFsDependencyAndComputesOffsetDuration() {
        let vm = buildGanttViewData(chart())
        XCTAssertEqual(vm.rows.map { $0.taskId }, ["a", "b", "c"])
        XCTAssertEqual(vm.range.start, "2026-08-01T00:00:00Z")
        XCTAssertEqual(vm.range.end, "2026-08-07T00:00:00Z")
        // a starts at range.start (offset 0, 2-day duration)
        XCTAssertEqual(vm.rows[0].offsetDays, 0)
        XCTAssertEqual(vm.rows[0].durationDays, 2)
        // b offset 2, c offset 4
        XCTAssertEqual(vm.rows[1].offsetDays, 2)
        XCTAssertEqual(vm.rows[2].offsetDays, 4)
        XCTAssertEqual(vm.rows[0].depth, 0)
        XCTAssertEqual(vm.rows[2].depth, 2)
        XCTAssertFalse(vm.hasCycle)
    }

    func testDefaultsZoomToWeekAndHonoursPersistedViewState() {
        let def = buildGanttViewData(chart())
        XCTAssertEqual(def.zoom, .week)
        let custom = buildGanttViewData(chart(), options: GanttViewOptions(zoom: .day, collapsedTaskIds: ["b"]))
        XCTAssertEqual(custom.zoom, .day)
        XCTAssertTrue(custom.rows.first { $0.taskId == "b" }!.collapsed)
        XCTAssertFalse(custom.rows.first { $0.taskId == "a" }!.collapsed)
    }

    func testLeavesUnscheduledRowsWithNilOffset() {
        let dto = GanttChartDTO(
            eventId: "evt_1",
            rows: [GanttRow(taskId: "a", title: "A", startsAt: nil, endsAt: nil, progressPercent: 0, assigneeId: nil)],
            dependencies: [])
        let vm = buildGanttViewData(dto)
        XCTAssertNil(vm.rows[0].offsetDays)
        XCTAssertEqual(vm.rows[0].durationDays, 0)
    }

    func testToPutGanttViewRequestProjectsPersistedFields() {
        let req = toPutGanttViewRequest(zoom: .month, collapsedTaskIds: ["t1", "t2"])
        XCTAssertEqual(req, PutGanttViewRequest(zoom: .month, collapsedTaskIds: ["t1", "t2"]))
    }
}
