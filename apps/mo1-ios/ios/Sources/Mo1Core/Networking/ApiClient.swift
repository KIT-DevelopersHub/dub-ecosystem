// ApiClient — MO3 `/m/v1/*` client (design §2-2). Owns the three cross-cutting
// behaviours that must match the TS reference (api-client.ts) exactly:
//   1. Bearer attach from the Keychain-backed TokenStore.
//   2. 401 -> single silent refresh -> retry ONCE (design §6, "1回性").
//   3. ErrorResponse -> semi-open DubClientError + retryable backoff (max 2).
import Foundation

public protocol MobileApi: Sendable {
    func exchange(_ req: MobileExchangeRequest) async throws -> MobileAuthSession
    func logout() async
    func getHome() async throws -> MobileHomeResponse
    func getEventOverview(_ eventId: String) async throws -> MobileEventOverviewResponse
    func listTasks(_ query: ListTasksQuery) async throws -> ListTasksResponse
    func patchTask(_ id: String, _ req: UpdateTaskRequest) async throws -> DubTask
    func getInbox(_ query: ListInboxQuery) async throws -> ListInboxResponse
    func registerDevice(_ req: RegisterDeviceRequest) async throws -> RegisterDeviceResponse
    func deleteDevice(_ deviceId: String) async throws
    func getGantt(_ query: GetGanttQuery) async throws -> GanttChartDTO
    func listChatChannels(_ query: CursorQuery) async throws -> ListChatChannelsResponse
    func listChatMessages(_ channelId: String, _ query: CursorQuery) async throws -> ListChatMessagesResponse
    func getChatWsTicket(_ channelId: String) async throws -> WsTicketResponse
}

public struct ApiClientConfig {
    /// origin of m-api.developershub.jp, e.g. "https://m-api.developershub.jp".
    public var baseURL: String
    public var transport: Transport
    public var tokenStore: TokenStore
    /// max retryable-error retries (default 2, design §6).
    public var maxRetries: Int
    /// injectable delay (ms) so tests don't wait real time.
    public var sleep: @Sendable (UInt64) async -> Void
    /// called after refresh fails / retry still 401: UI routes to S1 login.
    public var onSessionExpired: (@Sendable () -> Void)?

    public init(
        baseURL: String,
        transport: Transport,
        tokenStore: TokenStore,
        maxRetries: Int = 2,
        sleep: @escaping @Sendable (UInt64) async -> Void = { ms in try? await Task.sleep(nanoseconds: ms * 1_000_000) },
        onSessionExpired: (@Sendable () -> Void)? = nil
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokenStore = tokenStore
        self.maxRetries = maxRetries
        self.sleep = sleep
        self.onSessionExpired = onSessionExpired
    }
}

public final class MobileApiClient: MobileApi, @unchecked Sendable {
    private let cfg: ApiClientConfig
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    /// de-dupes concurrent 401s into a single in-flight refresh.
    private var refreshInFlight: Task<Bool, Never>?
    private let lock = NSLock()

    public init(_ cfg: ApiClientConfig) { self.cfg = cfg }

    // ---- typed endpoint wrappers (design §2-1) ------------------------------

    public func exchange(_ req: MobileExchangeRequest) async throws -> MobileAuthSession {
        try await request(.POST, "/auth/exchange", bodyData: try encoder.encode(req), anonymous: true)
    }

    public func logout() async {
        let session = cfg.tokenStore.read()
        // logout always clears local state regardless of server outcome.
        try? await requestVoid(.POST, "/auth/logout", bodyData: Data("{}".utf8))
        if session != nil { cfg.tokenStore.clear() }
    }

    public func getHome() async throws -> MobileHomeResponse {
        try await request(.GET, "/bff/home")
    }

    public func getEventOverview(_ eventId: String) async throws -> MobileEventOverviewResponse {
        try await request(.GET, "/events/\(Self.encodeComponent(eventId))")
    }

    public func listTasks(_ query: ListTasksQuery = ListTasksQuery()) async throws -> ListTasksResponse {
        try await request(.GET, "/tasks", query: [
            "cursor": query.cursor,
            "limit": query.limit.map(String.init),
            "eventId": query.eventId,
            "assigneeId": query.assigneeId,
        ])
    }

    public func patchTask(_ id: String, _ req: UpdateTaskRequest) async throws -> DubTask {
        try await request(.PATCH, "/tasks/\(Self.encodeComponent(id))", bodyData: try encoder.encode(req))
    }

    public func getInbox(_ query: ListInboxQuery = ListInboxQuery()) async throws -> ListInboxResponse {
        try await request(.GET, "/inbox", query: [
            "cursor": query.cursor,
            "limit": query.limit.map(String.init),
        ])
    }

    public func registerDevice(_ req: RegisterDeviceRequest) async throws -> RegisterDeviceResponse {
        try await request(.POST, "/devices", bodyData: try encoder.encode(req))
    }

    public func deleteDevice(_ deviceId: String) async throws {
        try await requestVoid(.DELETE, "/devices/\(Self.encodeComponent(deviceId))")
    }

    // ---- S6 gantt / S8 chat reads (design §2-1) -----------------------------

    /// S6 gantt chart read: rows + FS dependency lines for one event.
    public func getGantt(_ query: GetGanttQuery) async throws -> GanttChartDTO {
        try await request(.GET, "/gantt", query: ["eventId": query.eventId])
    }

    /// S8 chat: list the channels the caller can see.
    public func listChatChannels(_ query: CursorQuery = CursorQuery()) async throws -> ListChatChannelsResponse {
        try await request(.GET, "/chat/channels", query: [
            "cursor": query.cursor,
            "limit": query.limit.map(String.init),
        ])
    }

    /// S8 chat: page a channel's message history (oldest resolved via cursor).
    public func listChatMessages(_ channelId: String, _ query: CursorQuery = CursorQuery()) async throws -> ListChatMessagesResponse {
        try await request(.GET, "/chat/channels/\(Self.encodeComponent(channelId))/messages", query: [
            "cursor": query.cursor,
            "limit": query.limit.map(String.init),
        ])
    }

    /// S8 chat: short-lived ticket for the DO-direct (gateway-bypassing) WS.
    public func getChatWsTicket(_ channelId: String) async throws -> WsTicketResponse {
        try await request(.GET, "/chat/channels/\(Self.encodeComponent(channelId))/ws-ticket")
    }

    // ---- core ---------------------------------------------------------------

    private func request<T: Decodable>(
        _ method: HttpMethod, _ path: String,
        query: [String: String?] = [:], bodyData: Data? = nil, anonymous: Bool = false
    ) async throws -> T {
        let data = try await perform(method, path, query: query, bodyData: bodyData, anonymous: anonymous)
        return try decoder.decode(T.self, from: data)
    }

    private func requestVoid(
        _ method: HttpMethod, _ path: String,
        query: [String: String?] = [:], bodyData: Data? = nil, anonymous: Bool = false
    ) async throws {
        _ = try await perform(method, path, query: query, bodyData: bodyData, anonymous: anonymous)
    }

    private func perform(
        _ method: HttpMethod, _ path: String,
        query: [String: String?], bodyData: Data?, anonymous: Bool
    ) async throws -> Data {
        let url = buildURL(path, query)
        var attempt = 0
        var refreshedOnce = false

        while true {
            let res: TransportResponse
            do {
                res = try await cfg.transport.send(TransportRequest(
                    method: method, url: url, headers: headers(anonymous: anonymous), body: bodyData
                ))
            } catch {
                // transport failure = offline; retry within budget then surface.
                if attempt < cfg.maxRetries {
                    await backoff(attempt); attempt += 1; continue
                }
                throw ErrorMapper.offlineError(error)
            }

            if res.status >= 200 && res.status < 300 {
                return res.body
            }

            let err = ErrorMapper.fromResponseBody(status: res.status, body: res.body)

            // 401 -> one silent refresh -> retry once (authenticated calls only).
            if err.kind == .reauth && !anonymous {
                if !refreshedOnce {
                    refreshedOnce = true
                    if await ensureRefreshed() { continue } // retry with new token
                }
                // refresh failed, or retry still 401 -> session is unusable.
                cfg.tokenStore.clear()
                cfg.onSessionExpired?()
                throw err
            }

            // retryable upstream / rate-limit -> backoff (Retry-After wins).
            if err.retryable && attempt < cfg.maxRetries {
                await backoff(attempt, retryAfterSec: err.retryAfterSec); attempt += 1; continue
            }

            throw err
        }
    }

    /// Single-flight refresh: many concurrent 401s share one refresh call.
    private func ensureRefreshed() async -> Bool {
        let task = inFlightRefreshTask()
        let result = await task.value
        clearRefreshTask()
        return result
    }

    // Lock/unlock kept in synchronous helpers so they never straddle an await.
    private func inFlightRefreshTask() -> Task<Bool, Never> {
        lock.lock(); defer { lock.unlock() }
        if let existing = refreshInFlight { return existing }
        let task = Task { await self.doRefresh() }
        refreshInFlight = task
        return task
    }

    private func clearRefreshTask() {
        lock.lock(); defer { lock.unlock() }
        refreshInFlight = nil
    }

    private func doRefresh() async -> Bool {
        guard let current = cfg.tokenStore.read() else { return false }
        let res: TransportResponse
        do {
            var h = jsonHeaders()
            h["authorization"] = "Bearer \(current.token)" // theme8: current token is the refresh credential
            res = try await cfg.transport.send(TransportRequest(
                method: .POST, url: buildURL("/auth/refresh", [:]), headers: h,
                body: (try? encoder.encode(AuthRefreshRequest())) ?? Data("{}".utf8)
            ))
        } catch {
            return false
        }
        guard res.status >= 200 && res.status < 300,
              let session = try? decoder.decode(MobileAuthSession.self, from: res.body)
        else { return false }
        cfg.tokenStore.write(StoredSession(token: session.token, sessionExpiresAt: session.session.sessionExpiresAt))
        return true
    }

    private func buildURL(_ path: String, _ query: [String: String?]) -> String {
        var base = cfg.baseURL
        while base.hasSuffix("/") { base.removeLast() }
        var url = "\(base)\(MOBILE_API_PREFIX)\(path)"
        let pairs = query.compactMap { key, value -> String? in
            guard let value else { return nil }
            let ek = key.addingPercentEncoding(withAllowedCharacters: Self.queryAllowed) ?? key
            let ev = value.addingPercentEncoding(withAllowedCharacters: Self.queryAllowed) ?? value
            return "\(ek)=\(ev)"
        }.sorted()
        if !pairs.isEmpty { url += "?\(pairs.joined(separator: "&"))" }
        return url
    }

    private func jsonHeaders() -> [String: String] {
        ["content-type": "application/json", "accept": "application/json"]
    }

    private func headers(anonymous: Bool) -> [String: String] {
        var h = jsonHeaders()
        if !anonymous, let s = cfg.tokenStore.read() {
            h["authorization"] = "Bearer \(s.token)"
        }
        return h
    }

    private func backoff(_ attempt: Int, retryAfterSec: Double? = nil) async {
        let ms: UInt64
        if let retryAfterSec {
            ms = UInt64(retryAfterSec * 1000)
        } else {
            ms = UInt64(pow(2.0, Double(attempt)) * 200)
        }
        await cfg.sleep(ms)
    }

    private static let queryAllowed: CharacterSet = {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "-._~")
        return s
    }()

    private static func encodeComponent(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: queryAllowed) ?? raw
    }
}
