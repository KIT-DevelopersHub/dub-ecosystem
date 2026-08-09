// Push tests — Swift counterpart of test/push.test.ts (design §2-2 PushKit).
import XCTest
@testable import Mo1Core

final class PushTests: XCTestCase {
    func testResolvesDeepLinkBadgeMetadataFromData() {
        let payload = MobilePushPayload(title: "New task", body: "You were assigned a task", data: [
            "deepLink": "https://m.developershub.jp/tasks/task_5",
            "badge": "3",
            "notificationId": "ntf_1",
            "type": "task.assigned",
            "correlationId": "req_1",
        ])
        let parsed = parsePush(payload)
        XCTAssertEqual(parsed.route, Route(name: .task, params: ["taskId": "task_5"]))
        XCTAssertEqual(parsed.badge, 3)
        XCTAssertEqual(parsed.notificationId, "ntf_1")
        XCTAssertEqual(parsed.type, "task.assigned")
        XCTAssertEqual(parsed.correlationId, "req_1")
    }

    func testDefaultsToHomeAndNilBadgeWhenDataAbsent() {
        let parsed = parsePush(MobilePushPayload(title: "Hi", body: "there"))
        XCTAssertEqual(parsed.route.name, .home)
        XCTAssertNil(parsed.badge)
        XCTAssertNil(parsed.notificationId)
    }

    func testNeverThrowsOnNonNumericBadge() {
        let parsed = parsePush(MobilePushPayload(title: "t", body: "b", data: ["badge": "NaN"]))
        XCTAssertNil(parsed.badge)
    }
}
