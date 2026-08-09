// Capabilities tests — Swift counterpart of test/capabilities.test.ts (design §6).
import XCTest
@testable import Mo1Core

final class CapabilitiesTests: XCTestCase {
    func testShowsEditUIOnlyWhenCapabilityGranted() {
        XCTAssertFalse(canEditEvent(["event:read"]))
        XCTAssertTrue(canEditEvent(["event:read", "event:write"]))
        XCTAssertFalse(canWriteTask(["task:read"]))
        XCTAssertTrue(canWriteTask(["task:write"]))
    }

    func testDefaultDenyForEmptyCapabilitySet() {
        XCTAssertFalse(can([], "task:write"))
    }
}
