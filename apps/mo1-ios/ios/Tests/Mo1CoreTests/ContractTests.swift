// Contract tests — the Swift Codable round-trip that mirrors test/contract.test.ts
// (design §7 "契約適合: OpenAPI 生成型とラウンドトリップ一致"). These shapes MUST
// stay identical to the generated Swift models the MO3 OpenAPI spec produces.
import XCTest
@testable import Mo1Core

final class ContractTests: XCTestCase {
    private func roundtrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func testMobileHomeResponse() throws {
        let home = MobileHomeResponse(upcomingEvents: [], myTasks: [], unreadCount: 0)
        XCTAssertEqual(try roundtrip(home), home)
    }

    func testRegisterDeviceRequestResponse() throws {
        let req = RegisterDeviceRequest(platform: .ios, pushToken: "apns-token")
        let res = RegisterDeviceResponse(deviceId: "dev_01H")
        XCTAssertEqual(try roundtrip(req), req)
        XCTAssertEqual(try roundtrip(res), res)
    }

    func testMobilePushPayloadCarriesRoutingMetadataInData() throws {
        let p = MobilePushPayload(title: "t", body: "b", data: ["deepLink": "dub://inbox"])
        XCTAssertEqual(try roundtrip(p), p)
    }

    func testUpdateTaskRequestAlwaysCarriesVersion() throws {
        let patch = UpdateTaskRequest(version: 2, status: .done)
        XCTAssertEqual(try roundtrip(patch).version, 2)
    }

    func testMobileEventOverviewResponseCapabilitiesArePermissionKeys() throws {
        let ov = MobileEventOverviewResponse(
            event: EventSummary(id: "evt_1", title: "Conf", phase: .planning, startsAt: nil),
            capabilities: ["event:read", "task:write"]
        )
        XCTAssertEqual(try roundtrip(ov), ov)
    }

    func testUpdateTaskRequestOmitsNilFields() throws {
        // status-only patch must serialize to just { version, status } (no nulls).
        let data = try JSONEncoder().encode(UpdateTaskRequest(version: 4, status: .done))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["version", "status"])
    }
}
