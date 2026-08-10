// ChatView — S8 Chat (design §5 S8). A scrolling message list with an optimistic
// composer: the user's message shows instantly (pending), reconciles to sent on
// the echoed RT event, or shows a failure glyph if the socket is down. Own vs
// others' messages are left/right aligned. The DO-direct socket comes from the
// injected ChatSocketFactory (real URLSessionWebSocket in the app, stub in tests).
import SwiftUI
import Mo1Core

public struct ChatView: View {
    @StateObject private var vm: ChatViewModel
    private let title: String

    public init(api: MobileApi, channelId: Ids.ChannelId, selfId: Ids.UserId, factory: ChatSocketFactory, title: String = "Chat") {
        _vm = StateObject(wrappedValue: ChatViewModel(api: api, channelId: channelId, selfId: selfId, factory: factory))
        self.title = title
    }

    public var body: some View {
        VStack(spacing: 0) {
            messageList
            Divider()
            composer
        }
        .navigationTitle(title)
        .task { await vm.start() }
        .onDisappear { vm.disconnect() }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(vm.messages) { message in
                        MessageBubble(message: message, mine: vm.isMine(message)).id(message.id)
                    }
                }
                .padding()
            }
            .onChange(of: vm.messages.count) { _, _ in
                if let last = vm.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message", text: $vm.draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            Button {
                vm.send()
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(vm.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(8)
    }
}

private struct MessageBubble: View {
    let message: ChatMessageVM
    let mine: Bool

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                Text(message.body)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(mine ? Color.accentColor.opacity(0.85) : Color.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(mine ? .white : .primary)
                statusLine
            }
            if !mine { Spacer(minLength: 40) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    @ViewBuilder private var statusLine: some View {
        switch message.status {
        case .pending:
            Text("Sending…").font(.caption2).foregroundStyle(.secondary)
        case .failed:
            Label("Failed to send", systemImage: "exclamationmark.circle").font(.caption2).foregroundStyle(.red)
        case .sent:
            EmptyView()
        }
    }
}
