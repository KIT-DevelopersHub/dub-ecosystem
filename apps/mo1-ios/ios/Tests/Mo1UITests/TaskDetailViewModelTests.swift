// TaskDetailViewModel tests — optimistic status PATCH commit + 409 rollback +
// illegal-transition guard (design §5 S5, §6 CONFLICT).
import XCTest
import Mo1Core
@testable import Mo1UI

@MainActor
final class TaskDetailViewModelTests: XCTestCase {
    private func store() -> InMemoryTokenStore {
        let s = InMemoryTokenStore()
        s.write(StoredSession(token: "t", sessionExpiresAt: 1))
        return s
    }

    func testSuccessfulPatchCommitsAuthoritativeValue() async {
        let s = store()
        let updated = uiSampleTask(version: 4, status: .done)
        let vm = TaskDetailViewModel(task: uiSampleTask(version: 3, status: .inProgress), api: makeClient([jsonStep(updated)], store: s))

        await vm.changeStatus(to: .done)

        XCTAssertEqual(vm.task.status, .done)
        XCTAssertEqual(vm.task.version, 4)
        XCTAssertEqual(vm.displayStatus, .done)
        XCTAssertFalse(vm.optimistic.pending)
        XCTAssertFalse(vm.needsRefetch)
        XCTAssertNil(vm.errorKind)
    }

    func testVersionConflictRollsBackAndFlagsRefetch() async {
        let s = store()
        let vm = TaskDetailViewModel(
            task: uiSampleTask(version: 3, status: .inProgress),
            api: makeClient([errorStep("TASK_VERSION_CONFLICT", status: 409)], store: s)
        )

        await vm.changeStatus(to: .done)

        XCTAssertEqual(vm.displayStatus, .inProgress) // rolled back to snapshot
        XCTAssertEqual(vm.task.status, .inProgress)   // authoritative state untouched
        XCTAssertFalse(vm.optimistic.pending)
        XCTAssertTrue(vm.needsRefetch)
        XCTAssertEqual(vm.errorKind, .conflict)
    }

    func testIllegalTransitionIsANoOp() async {
        let s = store()
        let client = makeClient([jsonStep(uiSampleTask())], store: s)
        let vm = TaskDetailViewModel(task: uiSampleTask(version: 3, status: .blocked), api: client)

        // blocked -> done is not allowed (done only via in_progress).
        await vm.changeStatus(to: .done)

        XCTAssertEqual(vm.task.status, .blocked)
        XCTAssertEqual(vm.displayStatus, .blocked)
        XCTAssertFalse(vm.optimistic.pending)
        XCTAssertNil(vm.errorKind)
    }
}
