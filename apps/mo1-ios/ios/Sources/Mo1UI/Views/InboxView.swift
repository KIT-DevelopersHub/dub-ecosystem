// InboxView — notification inbox (design §5, §7 Push). Lists InboxItems with an
// unread dot, an unread count in the title, and cursor-based "load more".
import SwiftUI
import Mo1Core

public struct InboxView: View {
    @StateObject private var vm: InboxViewModel

    public init(api: MobileApi) {
        _vm = StateObject(wrappedValue: InboxViewModel(api: api))
    }

    public var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.items.isEmpty {
                    ProgressView("Loading…")
                } else if vm.items.isEmpty {
                    ContentUnavailableView("No notifications", systemImage: "bell.slash", description: Text("You're all caught up."))
                } else {
                    List {
                        ForEach(vm.items) { item in
                            InboxRow(item: item)
                        }
                        if vm.nextCursor != nil {
                            HStack { Spacer(); ProgressView(); Spacer() }
                                .task { await vm.loadMore() }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await vm.load() }
                }
            }
            .navigationTitle(vm.unreadCount > 0 ? "Inbox (\(vm.unreadCount))" : "Inbox")
        }
        .task { await vm.load() }
    }
}

private struct InboxRow: View {
    let item: InboxItem
    private var isUnread: Bool { item.readAt == nil }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(isUnread ? Color.accentColor : Color.clear)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(isUnread ? .headline : .subheadline)
                Text(item.body).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                Text(item.createdAt).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}
