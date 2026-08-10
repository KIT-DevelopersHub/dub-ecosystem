// Chat tests — Swift counterpart of test/chat.test.ts (design §2-1 S8):
// optimistic append + RT reconcile reducers, the DO-direct URL, and a
// ChatSession over an injected stub socket.
import XCTest
@testable import Mo1Core

final class ChatTests: XCTestCase {
    private let CH = "ch_1"

    private func msg(_ id: String, _ author: String, _ body: String, _ at: String) -> ChatMessage {
        ChatMessage(id: id, channelId: CH, authorId: author, body: body, createdAt: at)
    }

    // ---- reducers -----------------------------------------------------------

    func testLoadHistorySortsMarksSentAndDedupes() {
        var s = emptyChannel(CH)
        s = loadHistory(s, [
            msg("m2", "u2", "second", "2026-08-09T00:02:00Z"),
            msg("m1", "u1", "first", "2026-08-09T00:01:00Z"),
            msg("m1", "u1", "dupe", "2026-08-09T00:03:00Z"), // dupe id ignored
        ])
        XCTAssertEqual(s.messages.map { $0.id }, ["m1", "m2"])
        XCTAssertTrue(s.messages.allSatisfy { $0.status == .sent })
    }

    func testAppendOptimisticShowsPendingImmediately() {
        let s = appendOptimistic(emptyChannel(CH), OptimisticSend(localId: "l1", authorId: "me", body: "hi", createdAt: "2026-08-09T00:00:00Z"))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].status, .pending)
        XCTAssertEqual(s.messages[0].localId, "l1")
    }

    func testMessageCreatedReconcilesPendingToSent() {
        var s = appendOptimistic(emptyChannel(CH), OptimisticSend(localId: "l1", authorId: "me", body: "hi", createdAt: "2026-08-09T00:00:00Z"))
        s = applyRealtimeEvent(s, .messageCreated(channelId: CH, messageId: "srv1", authorId: "me", body: "hi", at: "2026-08-09T00:00:01Z"))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].id, "srv1")
        XCTAssertEqual(s.messages[0].status, .sent)
        XCTAssertNil(s.messages[0].localId)
    }

    func testMessageCreatedFromAnotherAuthorAppendsNewSent() {
        var s = appendOptimistic(emptyChannel(CH), OptimisticSend(localId: "l1", authorId: "me", body: "hi", createdAt: "2026-08-09T00:00:00Z"))
        s = applyRealtimeEvent(s, .messageCreated(channelId: CH, messageId: "srv2", authorId: "other", body: "yo", at: "2026-08-09T00:00:02Z"))
        XCTAssertEqual(s.messages.count, 2)
        XCTAssertTrue(s.messages.contains { $0.id == "srv2" && $0.status == .sent })
    }

    func testMessageCreatedIsIdempotentByMessageId() {
        var s = loadHistory(emptyChannel(CH), [msg("srv1", "me", "hi", "2026-08-09T00:00:00Z")])
        let before = s
        s = applyRealtimeEvent(s, .messageCreated(channelId: CH, messageId: "srv1", authorId: "me", body: "hi", at: "2026-08-09T00:00:00Z"))
        XCTAssertEqual(s, before)
    }

    func testMessageDeletedRemovesMessage() {
        var s = loadHistory(emptyChannel(CH), [msg("m1", "u1", "x", "2026-08-09T00:00:00Z")])
        s = applyRealtimeEvent(s, .messageDeleted(channelId: CH, messageId: "m1", at: "2026-08-09T00:01:00Z"))
        XCTAssertTrue(s.messages.isEmpty)
    }

    func testIgnoresOtherChannelAndMemberEvents() {
        let s = loadHistory(emptyChannel(CH), [msg("m1", "u1", "x", "2026-08-09T00:00:00Z")])
        XCTAssertEqual(applyRealtimeEvent(s, .messageDeleted(channelId: "other", messageId: "m1", at: "z")), s)
        XCTAssertEqual(applyRealtimeEvent(s, .memberAdded(channelId: CH, userId: "u9", at: "z")), s)
    }

    func testMarkFailedFlipsPendingAndNoOpsOtherwise() {
        var s = appendOptimistic(emptyChannel(CH), OptimisticSend(localId: "l1", authorId: "me", body: "hi", createdAt: "2026-08-09T00:00:00Z"))
        s = markFailed(s, "l1")
        XCTAssertEqual(s.messages[0].status, .failed)
        XCTAssertEqual(markFailed(s, "nope"), s) // no-op
    }

    // ---- DO-direct URL ------------------------------------------------------

    func testChatSocketUrlAppendsTicket() {
        let url = chatSocketUrl(WsTicketResponse(ticket: "tkt", doUrl: "wss://do.example/room/1", expiresAt: "z"))
        XCTAssertTrue(url.contains("ticket=tkt"))
        XCTAssertTrue(url.hasPrefix("wss://do.example/room/1"))
    }

    // ---- ChatSession over an injected WS stub -------------------------------

    func testSendAppendsOptimisticallyTransmitsAndRtEchoConfirms() {
        let factory = StubChatSocketFactory()
        var seq = 0
        let session = ChatSession(
            channelId: CH, selfId: "me", factory: factory,
            newLocalId: { defer { seq += 1 }; return "l\(seq)" },
            now: { 1_700_000_000_000 })
        session.connect(WsTicketResponse(ticket: "tkt", doUrl: "wss://do.example/room/1", expiresAt: "z"))
        let localId = session.send("hello")

        XCTAssertEqual(factory.socket?.sent.count, 1)
        XCTAssertEqual(factory.socket?.sent.first?.body, "hello")
        XCTAssertEqual(factory.socket?.sent.first?.localId, localId)
        XCTAssertEqual(session.currentState.messages.first?.status, .pending)

        factory.socket?.emit(.messageCreated(channelId: CH, messageId: "srv", authorId: "me", body: "hello", at: "2026-08-09T00:00:00Z"))
        XCTAssertEqual(session.currentState.messages.count, 1)
        XCTAssertEqual(session.currentState.messages.first?.id, "srv")
        XCTAssertEqual(session.currentState.messages.first?.status, .sent)
    }

    func testMarksFailedWhenSocketNotConnected() {
        let session = ChatSession(channelId: CH, selfId: "me", factory: StubChatSocketFactory(), newLocalId: { "l0" })
        session.send("hi") // never connected
        XCTAssertEqual(session.currentState.messages.first?.status, .failed)
    }

    func testCloseShutsTheSocket() {
        let factory = StubChatSocketFactory()
        let session = ChatSession(channelId: CH, selfId: "me", factory: factory)
        session.connect(WsTicketResponse(ticket: "t", doUrl: "wss://do.example/room/1", expiresAt: "z"))
        session.close()
        XCTAssertEqual(factory.socket?.closed, true)
    }

    // ---- RT event Codable round-trip ---------------------------------------

    func testRealtimeEventDecodesFromWireFrame() throws {
        let json = #"{"kind":"message.created","channelId":"ch_1","messageId":"m1","authorId":"u1","body":"hi","at":"2026-08-09T00:00:00Z"}"#
        let ev = try JSONDecoder().decode(ChatRealtimeEvent.self, from: Data(json.utf8))
        XCTAssertEqual(ev, .messageCreated(channelId: "ch_1", messageId: "m1", authorId: "u1", body: "hi", at: "2026-08-09T00:00:00Z"))
    }
}
