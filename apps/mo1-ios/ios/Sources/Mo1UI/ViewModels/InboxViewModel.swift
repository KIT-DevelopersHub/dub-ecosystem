// InboxViewModel — notification inbox (design §2-1, §7 Push). Pages the frozen
// InboxItem list via the ApiClient, tracks the unread count, and appends the
// next cursor page. Read-state mutation (PATCH /inbox/:id) lands with the
// notification write wave; P0 surfaces the list + unread badge.
import Foundation
import Combine
import Mo1Core

@MainActor
public final class InboxViewModel: ObservableObject {
    @Published public private(set) var items: [InboxItem] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorKind: ClientErrorKind?
    @Published public private(set) var nextCursor: String?

    private let api: MobileApi

    public init(api: MobileApi) { self.api = api }

    /// Count of items still unread (readAt == nil).
    public var unreadCount: Int { items.filter { $0.readAt == nil }.count }

    /// Reload the first page (pull-to-refresh / first appear).
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await api.getInbox(ListInboxQuery(limit: 30))
            items = res.items
            nextCursor = res.nextCursor
            errorKind = nil
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }

    /// Append the next cursor page (no-op at the end of the list).
    public func loadMore() async {
        guard let cursor = nextCursor, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await api.getInbox(ListInboxQuery(cursor: cursor, limit: 30))
            items.append(contentsOf: res.items)
            nextCursor = res.nextCursor
        } catch let err as DubClientError {
            errorKind = err.kind
        } catch {
            errorKind = .unknown
        }
    }
}
