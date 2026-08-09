// Transport — the injectable HTTP boundary (mirrors transport.ts / URLSession).
// Keeping it a protocol lets ApiClient + ViewModel logic be unit-tested without
// a network. A thrown error means transport failure; an HTTP error *status* is
// a resolved TransportResponse, not a throw.
import Foundation

public enum HttpMethod: String, Sendable {
    case GET, POST, PATCH, DELETE
}

public struct TransportRequest: Sendable {
    public var method: HttpMethod
    /// absolute URL (baseUrl + `/m/v1` path + query already applied).
    public var url: String
    public var headers: [String: String]
    /// JSON body bytes, or nil for GET/DELETE.
    public var body: Data?
    public init(method: HttpMethod, url: String, headers: [String: String], body: Data? = nil) {
        self.method = method; self.url = url; self.headers = headers; self.body = body
    }
}

public struct TransportResponse: Sendable {
    public var status: Int
    public var headers: [String: String]
    /// raw response bytes (empty Data for an empty body).
    public var body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status; self.headers = headers; self.body = body
    }
}

public protocol Transport: Sendable {
    func send(_ request: TransportRequest) async throws -> TransportResponse
}
