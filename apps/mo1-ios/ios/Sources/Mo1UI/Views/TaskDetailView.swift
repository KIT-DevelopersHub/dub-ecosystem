// TaskDetailView — task detail with optimistic status changes (design §5 S5).
// Status buttons are gated by the resource capabilities and the frozen
// transition table; a tap flips the UI immediately and rolls back on a 409.
import SwiftUI
import Mo1Core

public struct TaskDetailView: View {
    @StateObject private var vm: TaskDetailViewModel
    private let capabilities: [PermissionKey]

    public init(task: DubTask, api: MobileApi, capabilities: [PermissionKey]) {
        _vm = StateObject(wrappedValue: TaskDetailViewModel(task: task, api: api))
        self.capabilities = capabilities
    }

    public var body: some View {
        List {
            Section("Task") {
                Text(vm.task.title).font(.headline)
                if let description = vm.task.description, !description.isEmpty {
                    Text(description).foregroundStyle(.secondary)
                }
                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        if vm.optimistic.pending { ProgressView() }
                        Text(vm.displayStatus.rawValue)
                    }
                }
                LabeledContent("Priority", value: vm.task.priority.rawValue)
            }

            if canWriteTask(capabilities) {
                Section("Change status") {
                    ForEach(TaskStatus.allCases, id: \.self) { status in
                        if canTransition(vm.task.status, status) && status != vm.task.status {
                            Button(status.rawValue) {
                                Task { await vm.changeStatus(to: status) }
                            }
                            .disabled(vm.optimistic.pending)
                        }
                    }
                }
            }

            if vm.needsRefetch {
                Section {
                    Text("This task changed on the server. Pull to refresh.")
                        .font(.footnote).foregroundStyle(.orange)
                }
            }
        }
        .navigationTitle("Task")
    }
}
