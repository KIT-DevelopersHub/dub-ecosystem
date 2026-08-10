// ApiClient gantt/chat reads — Swift counterpart of the /m/v1/gantt and
// /m/v1/chat/* read tests in test/gantt.test.ts + test/chat.test.ts.
import XCTest
@testable import Mo1Core

final class ApiClientGanttChatTests: XCTestCase {
    let base = "https://m-api.developershub.jp"

    private func makeClient(_ transport: ScriptedTransport, store: TokenStore) -> MobileApiClient {
        MobileApiClient(ApiClientConfig(baseURL: base, transport: transport, tokenStore: store, sleep: noSleep))
    }

    func testGetGanttGetsChartWithEventIdQuery() async throws {
        let store = seededStore("tok")
        let chart = GanttChartDTO(eventId: "evt_1", rows: [], dependencies: [])
        let transport = ScriptedTransport([okStep(chart)])
        let client = makeClient(transport, store: store)

        let res = try await client.getGantt(GetGanttQuery(eventId: "evt_1"))

        XCTAssertEqual(transport.calls[0].url, "\(base)/m/v1/gantt?eventId=evt_1")
        XCTAssertEqual(transport.calls[0].headers["authorization"], "Bearer tok")
        XCTAssertEqual(res, chart)
    }

    func testListsChannelsMessagesAndFetchesWsTicket() async throws {
        let store = seededStore("tok")
        let channels = Paginated<ChatChannel>(items: [ChatChannel(id: "ch_1", name: "general", createdAt: "2026-08-09T00:00:00Z")], nextCursor: nil)
        let messages = Paginated<ChatMessage>(items: [], nextCursor: "c2")
        let ticket = WsTicketResponse(ticket: "tkt", doUrl: "wss://do.example/room/1", expiresAt: "2026-08-09T00:10:00Z")
        let transport = ScriptedTransport([okStep(channels), okStep(messages), okStep(ticket)])
        let client = makeClient(transport, store: store)

        let gotChannels = try await client.listChatChannels()
        XCTAssertEqual(transport.calls[0].url, "\(base)/m/v1/chat/channels")
        XCTAssertEqual(gotChannels.items.first?.id, "ch_1")

        let gotMessages = try await client.listChatMessages("ch_1", CursorQuery(limit: 30))
        XCTAssertEqual(transport.calls[1].url, "\(base)/m/v1/chat/channels/ch_1/messages?limit=30")
        XCTAssertEqual(gotMessages.nextCursor, "c2")

        let gotTicket = try await client.getChatWsTicket("ch_1")
        XCTAssertEqual(transport.calls[2].url, "\(base)/m/v1/chat/channels/ch_1/ws-ticket")
        XCTAssertEqual(gotTicket.ticket, "tkt")
    }
}
