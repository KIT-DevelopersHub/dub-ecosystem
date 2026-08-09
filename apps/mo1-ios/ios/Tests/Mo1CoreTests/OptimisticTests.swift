// Optimistic tests — Swift counterpart of test/optimistic.test.ts (design §5 S5,
// §6 CONFLICT).
import XCTest
@testable import Mo1Core

final class OptimisticTests: XCTestCase {
    func testHonoursFrozenTransitionTable() {
        XCTAssertTrue(canTransition(.inProgress, .done))
        XCTAssertFalse(canTransition(.done, .todo)) // done reopens only to in_progress
        XCTAssertFalse(canTransition(.blocked, .done))
        XCTAssertTrue(canTransition(.todo, .todo))
    }

    func testBeginShowsNextAndKeepsRollbackSnapshot() {
        let s = begin(TaskStatus.todo, TaskStatus.done)
        XCTAssertEqual(s.value, .done)
        XCTAssertEqual(s.rollbackTo, .todo)
        XCTAssertTrue(s.pending)
    }

    func testCommitAdoptsServerValueAndSettles() {
        let s = commit(begin(TaskStatus.todo, TaskStatus.done), TaskStatus.done)
        XCTAssertEqual(s, settled(TaskStatus.done))
        XCTAssertFalse(s.pending)
    }

    func testRollbackRestoresPreEditValueOn409() {
        let s = rollback(begin(TaskStatus.todo, TaskStatus.done))
        XCTAssertEqual(s.value, .todo)
        XCTAssertFalse(s.pending)
    }

    func testRollbackIsNoOpWhenAlreadySettled() {
        XCTAssertEqual(rollback(settled(TaskStatus.blocked)).value, .blocked)
    }

    func testStatusPatchCarriesCurrentVersion() {
        let patch = statusPatch(sampleTask(version: 7), .done)
        XCTAssertEqual(patch, UpdateTaskRequest(version: 7, status: .done))
    }

    func testRecognisesVersionConflictError() {
        XCTAssertTrue(isVersionConflict(ErrorMapper.fromResponseBody(status: 409, body: errData("TASK_VERSION_CONFLICT"))))
        XCTAssertFalse(isVersionConflict(ErrorMapper.fromResponseBody(status: 403, body: errData("FORBIDDEN"))))
    }
}
