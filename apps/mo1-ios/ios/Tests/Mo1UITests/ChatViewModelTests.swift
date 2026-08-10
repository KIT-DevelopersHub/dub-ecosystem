// ChatViewModel tests — S8 start (history + ws-ticket + connect) and optimistic
// send reconciled by an injected stub socket's RT echo.
import XCTest
import Mo1Core
@testable import Mo1UI

@MainActor
final class ChatViewModelTests: XCTestCase {
    private let CH = "ch_1"

    /// Drain a few MainActor turns so ChatSession.onChange hops land.
    private func flush() async {
        for _ in 0..<5 { await Task.yield() }
    }

    private func startSteps() -> [UIStep] {
        [
            jsonStep(Paginated<ChatMessage>(items: [
                ChatMessage(id: "m0", channelId: "ch_1", authorId: "other", body: "hey", createdAt: "2026-08-09T00:00:00Z"),
            ], nextCursor: nil)),
            jsonStep(WsTicketResponse(ticket: "tkt", doUrl: "wss://do.example/room/1", expiresAt: "2026-08-09T00:10:00Z")),
        ]
    }

    func testStartLoadsHistoryAndConnects() async {
        let factory = StubChatSocketFactory()
        let vm = ChatViewModel(api: makeClient(startSteps(), store: seededUIStore()), channelId: CH, selfId: "me", factory: factory)

        await vm.start()
        await flush()

        XCTAssertEqual(vm.messages.map { $0.id }, ["m0"])
        XCTAssertTrue(vm.isConnected)
        XCTAssertNotNil(factory.socket)
        XCTAssertTrue(factory.socket!.url.contains("ticket=tkt"))
    }

    func testSendAppendsOptimisticallyThenRtEchoConfirms() async {
        let factory = StubChatSocketFactory()
        let vm = ChatViewModel(api: makeClient(startSteps(), store: seededUIStore()), channelId: CH, selfId: "me", factory: factory)
        await vm.start()
        await flush()

        vm.draft = "  hello  "
        vm.send()
        XCTAssertEqual(vm.draft, "") // cleared synchronously
        XCTAssertEqual(factory.socket?.sent.first?.body, "hello") // transmitted synchronously
        // state mirrors through a MainActor hop; flush it.
        await flush()
        XCTAssertEqual(vm.messages.last?.status, .pending)

        let localId = factory.socket!.sent.first!.localId
        factory.socket?.emit(.messageCreated(channelId: CH, messageId: "srv", authorId: "me", body: "hello", at: "2026-08-09T00:01:00Z"))
        await flush()

        XCTAssertTrue(vm.messages.contains { $0.id == "srv" && $0.status == .sent })
        XCTAssertFalse(vm.messages.contains { $0.localId == localId && $0.status == .pending })
        XCTAssertTrue(vm.isMine(vm.messages.last!))
    }

    func testStartSurfacesErrorKind() async {
        let vm = ChatViewModel(api: makeClient([errorStep("UNAUTHENTICATED", status: 401)], store: seededUIStore()), channelId: CH, selfId: "me", factory: StubChatSocketFactory())
        await vm.start()
        XCTAssertEqual(vm.errorKind, .reauth)
        XCTAssertFalse(vm.isConnected)
    }
}
