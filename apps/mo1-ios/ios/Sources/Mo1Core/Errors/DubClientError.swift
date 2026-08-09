// Errors — client-side semi-open error model (the Swift 準開放 enum the TS
// errors.ts mirrors, design §6). Server errors arrive as a @dub/errors
// ErrorResponse whose `code` is an OPEN set (CommonErrorCode | service codes).
// We never drop an unknown code: common codes get a typed `kind`, everything
// else falls through to `.unknown` so the UI degrades instead of crashing.
import Foundation

/// Common error codes (packages/errors/src/wire.ts CommonErrorCodes).
public enum CommonErrorCodes {
    public static let unauthenticated = "UNAUTHENTICATED"
    public static let forbidden = "FORBIDDEN"
    public static let notFound = "NOT_FOUND"
    public static let validationFailed = "VALIDATION_FAILED"
    public static let conflict = "CONFLICT"
    public static let preconditionFailed = "PRECONDITION_FAILED"
    public static let rateLimited = "RATE_LIMITED"
    public static let payloadTooLarge = "PAYLOAD_TOO_LARGE"
    public static let upstreamUnavailable = "UPSTREAM_UNAVAILABLE"
    public static let upstreamTimeout = "UPSTREAM_TIMEOUT"
    public static let internalError = "INTERNAL"
}

/// How the UI should react — the single branch point for §6's behaviour table.
public enum ClientErrorKind: String, Equatable, Sendable {
    case reauth        // 401: silent refresh then S1 login
    case forbidden     // 403: show read-only / hide capability UI
    case validation    // 400 VALIDATION_FAILED: field errors
    case conflict      // 409 (incl. *_VERSION_CONFLICT): rollback optimistic UI
    case rateLimited   // 429: backoff, honour Retry-After
    case upstream      // 502/504/UPSTREAM_*: retryable backoff
    case syncExpired   // 410 *_SYNC_CURSOR_EXPIRED: full refetch
    case offline       // transport failed (no response)
    case unknown       // any code/status we do not model — never crash
}

/// The typed error the app throws/handles. Conforms to `Error`.
public struct DubClientError: Error, Equatable, Sendable {
    public let code: String
    public let status: Int
    public let message: String
    public let retryable: Bool
    public let kind: ClientErrorKind
    public let retryAfterSec: Double?

    public init(code: String, status: Int, message: String, retryable: Bool, kind: ClientErrorKind, retryAfterSec: Double? = nil) {
        self.code = code; self.status = status; self.message = message
        self.retryable = retryable; self.kind = kind; self.retryAfterSec = retryAfterSec
    }
}

/// The single wire form all services / gateway / FE depend on (theme3 D7).
/// Decoded leniently: `details` may be an object *or* an array (FieldError[]),
/// so `retryAfterSec` extraction never fails the whole parse.
struct WireErrorEnvelope: Decodable {
    let error: WireError
}

struct WireError: Decodable {
    let code: String
    let message: String
    let retryable: Bool
    let retryAfterSec: Double?

    private enum CodingKeys: String, CodingKey { case code, message, retryable, details }
    private struct RetryDetails: Decodable { let retryAfterSec: Double? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        message = try c.decode(String.self, forKey: .message)
        retryable = try c.decode(Bool.self, forKey: .retryable)
        // `try?` swallows a type mismatch when details is an array or scalar;
        // it flattens the optional, so `details` is a non-optional RetryDetails.
        if let details = try? c.decodeIfPresent(RetryDetails.self, forKey: .details) {
            retryAfterSec = details.retryAfterSec
        } else {
            retryAfterSec = nil
        }
    }
}

public enum ErrorMapper {
    private static let upstreamCodes: Set<String> = [
        CommonErrorCodes.upstreamUnavailable,
        CommonErrorCodes.upstreamTimeout,
    ]

    static func kind(for code: String, status: Int) -> ClientErrorKind {
        switch code {
        case CommonErrorCodes.unauthenticated: return .reauth
        case CommonErrorCodes.forbidden: return .forbidden
        case CommonErrorCodes.validationFailed: return .validation
        case CommonErrorCodes.conflict: return .conflict
        case CommonErrorCodes.rateLimited: return .rateLimited
        default: break
        }
        if upstreamCodes.contains(code) { return .upstream }
        // Open service codes: classify by suffix convention, then by HTTP status.
        if code.hasSuffix("_VERSION_CONFLICT") || status == 409 { return .conflict }
        if code.hasSuffix("_SYNC_CURSOR_EXPIRED") || status == 410 { return .syncExpired }
        switch status {
        case 401: return .reauth
        case 403: return .forbidden
        case 400: return .validation
        case 429: return .rateLimited
        case 502, 504: return .upstream
        default: return .unknown
        }
    }

    /// Build a DubClientError from a decoded HTTP response body + status.
    public static func fromResponseBody(status: Int, body: Data) -> DubClientError {
        if let env = try? JSONDecoder().decode(WireErrorEnvelope.self, from: body) {
            let e = env.error
            return DubClientError(
                code: e.code,
                status: status,
                message: e.message,
                retryable: e.retryable,
                kind: kind(for: e.code, status: status),
                retryAfterSec: e.retryAfterSec
            )
        }
        // Non-envelope body: an unrecognised upstream failure (retryable).
        return DubClientError(
            code: CommonErrorCodes.upstreamUnavailable,
            status: status >= 500 ? status : 502,
            message: "Upstream returned an unrecognized error body",
            retryable: true,
            kind: .upstream
        )
    }

    /// Transport-level failure (no HTTP response at all) → offline, retryable.
    public static func offlineError(_ cause: Error? = nil) -> DubClientError {
        DubClientError(
            code: "OFFLINE",
            status: 0,
            message: cause?.localizedDescription ?? "Network unavailable",
            retryable: true,
            kind: .offline
        )
    }

    public static func isReauth(_ err: DubClientError) -> Bool { err.kind == .reauth }
}
