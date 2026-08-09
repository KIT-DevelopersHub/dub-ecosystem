// HomeView — S2 Home (design §5 S2). Shows upcoming events, an open-task
// preview, and the unread badge from HomeViewModel. Tapping a task pushes the
// task-detail screen.
import SwiftUI
import Mo1Core

public struct HomeView: View {
    @StateObject private var vm: HomeViewModel
    private let api: MobileApi
    private let onSignOut: () -> Void

    public init(api: MobileApi, onSignOut: @escaping () -> Void) {
        _vm = StateObject(wrappedValue: HomeViewModel(api: api))
        self.api = api
        self.onSignOut = onSignOut
    }

    public var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.state.isEmpty {
                    ProgressView("Loading…")
                } else if vm.state.isEmpty {
                    ContentUnavailableView("Nothing yet", systemImage: "tray", description: Text("No upcoming events or open tasks."))
                } else {
                    content
                }
            }
            .navigationTitle("Home")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Sign out", action: onSignOut)
                }
            }
        }
        .task { await vm.load() }
    }

    private var content: some View {
        List {
            if !vm.state.upcomingEvents.isEmpty {
                Section("Upcoming events") {
                    ForEach(vm.state.upcomingEvents) { event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.title).font(.headline)
                            Text(event.phase.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section {
                ForEach(vm.state.todayTasks) { task in
                    NavigationLink(value: task.id) {
                        Label(task.title, systemImage: statusIcon(task.status))
                    }
                }
            } header: {
                HStack {
                    Text("Your open tasks")
                    Spacer()
                    if vm.state.hasUnread {
                        Text("\(vm.state.unreadCount)")
                            .font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.red, in: Capsule())
                            .foregroundStyle(.white)
                    }
                }
            }
        }
        .navigationDestination(for: String.self) { taskId in
            // In P0 the detail is loaded lazily; a placeholder task is refined by
            // the detail screen's own fetch in a later wave.
            Text("Task \(taskId)")
        }
        .refreshable { await vm.load() }
    }

    private func statusIcon(_ status: TaskStatus) -> String {
        switch status {
        case .todo: return "circle"
        case .inProgress: return "circle.lefthalf.filled"
        case .blocked: return "exclamationmark.triangle"
        case .done: return "checkmark.circle.fill"
        case .cancelled: return "xmark.circle"
        }
    }
}
