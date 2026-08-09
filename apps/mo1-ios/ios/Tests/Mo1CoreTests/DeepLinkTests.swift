// DeepLink tests — Swift counterpart of test/deeplink.test.ts (design §2-3).
import XCTest
@testable import Mo1Core

final class DeepLinkTests: XCTestCase {
    func testParsesHttpsUniversalLinks() {
        XCTAssertEqual(parseDeepLink("https://m.developershub.jp/events/evt_9"), Route(name: .event, params: ["eventId": "evt_9"]))
        XCTAssertEqual(parseDeepLink("https://m.developershub.jp/tasks/task_2"), Route(name: .task, params: ["taskId": "task_2"]))
        XCTAssertEqual(parseDeepLink("https://m.developershub.jp/inbox"), Route(name: .inbox))
    }

    func testParsesDubFallbackLinks() {
        XCTAssertEqual(parseDeepLink("dub://events/evt_1"), Route(name: .event, params: ["eventId": "evt_1"]))
        XCTAssertEqual(parseDeepLink("dub://actions/act_1"), Route(name: .action, params: ["actionId": "act_1"]))
        XCTAssertEqual(parseDeepLink("dub://chat/ch_1"), Route(name: .chat, params: ["channelId": "ch_1"]))
    }

    func testFallsBackToHomeForUnknownForeignRetiredOrMalformed() {
        XCTAssertEqual(parseDeepLink("https://evil.example.com/tasks/x").name, .home)
        XCTAssertEqual(parseDeepLink("devhub://events/evt_1").name, .home) // retired scheme
        XCTAssertEqual(parseDeepLink("https://m.developershub.jp/nonsense").name, .home)
        XCTAssertEqual(parseDeepLink("not a url").name, .home)
    }

    func testRoutesBareHostPathToHome() {
        XCTAssertEqual(parseDeepLink("https://m.developershub.jp/").name, .home)
    }
}
