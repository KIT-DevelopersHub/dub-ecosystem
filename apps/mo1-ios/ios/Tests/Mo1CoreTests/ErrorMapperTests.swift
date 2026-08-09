// ErrorMapper tests — Swift counterpart of test/errors.test.ts (design §6
// semi-open error model).
import XCTest
@testable import Mo1Core

final class ErrorMapperTests: XCTestCase {
    func testMapsCommonCodesToTheirKind() {
        XCTAssertEqual(ErrorMapper.fromResponseBody(status: 401, body: errData("UNAUTHENTICATED")).kind, .reauth)
        XCTAssertEqual(ErrorMapper.fromResponseBody(status: 403, body: errData("FORBIDDEN")).kind, .forbidden)
        XCTAssertEqual(ErrorMapper.fromResponseBody(status: 400, body: errData("VALIDATION_FAILED")).kind, .validation)
        XCTAssertEqual(ErrorMapper.fromResponseBody(status: 409, body: errData("CONFLICT")).kind, .conflict)
        XCTAssertEqual(ErrorMapper.fromResponseBody(status: 429, body: errData("RATE_LIMITED")).kind, .rateLimited)
        XCTAssertEqual(ErrorMapper.fromResponseBody(status: 502, body: errData("UPSTREAM_UNAVAILABLE")).kind, .upstream)
    }

    func testClassifiesOpenServiceCodesBySuffixWithoutDropping() {
        let conflict = ErrorMapper.fromResponseBody(status: 409, body: errData("TASK_VERSION_CONFLICT"))
        XCTAssertEqual(conflict.kind, .conflict)
        XCTAssertEqual(conflict.code, "TASK_VERSION_CONFLICT")

        let sync = ErrorMapper.fromResponseBody(status: 410, body: errData("MOBILE_SYNC_CURSOR_EXPIRED"))
        XCTAssertEqual(sync.kind, .syncExpired)
    }

    func testFallsThroughToUnknownButKeepsCode() {
        let e = ErrorMapper.fromResponseBody(status: 418, body: errData("SOMETHING_WEIRD", "teapot"))
        XCTAssertEqual(e.kind, .unknown)
        XCTAssertEqual(e.code, "SOMETHING_WEIRD")
        XCTAssertEqual(e.status, 418)
    }

    func testReadsRetryAfterSecFromRateLimitedDetails() {
        let e = ErrorMapper.fromResponseBody(status: 429, body: errData("RATE_LIMITED", "slow down", retryAfterSec: 3))
        XCTAssertEqual(e.retryAfterSec, 3)
    }

    func testTreatsNonEnvelopeBodyAsRetryableUpstream() {
        let e = ErrorMapper.fromResponseBody(status: 500, body: Data("{\"oops\":true}".utf8))
        XCTAssertEqual(e.kind, .upstream)
        XCTAssertTrue(e.retryable)
    }

    func testOfflineErrorIsRetryableTransportFailure() {
        let e = ErrorMapper.offlineError(URLError(.notConnectedToInternet))
        XCTAssertEqual(e.kind, .offline)
        XCTAssertTrue(e.retryable)
        XCTAssertEqual(e.status, 0)
    }
}
