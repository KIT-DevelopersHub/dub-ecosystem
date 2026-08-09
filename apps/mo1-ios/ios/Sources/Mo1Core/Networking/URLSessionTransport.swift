// URLSessionTransport — the production Transport over URLSession (design §2-2
// "ApiClient over URLSession"). Only transport-level failures throw; any HTTP
// status resolves to a TransportResponse the ApiClient classifies.
import Foundation

public struct URLSessionTransport: Transport {
    private let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func send(_ request: TransportRequest) async throws -> TransportResponse {
        guard let url = URL(string: request.url) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = request.method.rawValue
        for (k, v) in request.headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = request.body

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let ks = k as? String, let vs = v as? String { headers[ks.lowercased()] = vs }
        }
        return TransportResponse(status: http.statusCode, headers: headers, body: data)
    }
}
