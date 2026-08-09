// TaskDetailViewModel — task-detail screen with an optimistic status PATCH
// (design §5 S5, §6 CONFLICT). Shows the next status immediately, commits on the
// server's authoritative value, and rolls back to the snapshot on a 409
// *_VERSION_CONFLICT (flagging a refetch).
import Foundation
import Combine
import Mo1Core

@MainActor
public final class TaskDetailViewModel: ObservableObject {
    @Published public private(set) var task: DubTask
    @Published public private(set) var optimistic: OptimisticState<TaskStatus>
    @Published public private(set) var errorKind: ClientErrorKind?
    /// set when a 409 conflict means the UI should refetch authoritative state.
    @Published public private(set) var needsRefetch = false

    private let api: MobileApi

    public init(task: DubTask, api: MobileApi) {
        self.task = task
        self.optimistic = settled(task.status)
        self.api = api
    }

    /// The status the UI should render right now (optimistic while pending).
    public var displayStatus: TaskStatus { optimistic.value }

    public func changeStatus(to next: TaskStatus) async {
        guard canTransition(task.status, next) else { return }
        needsRefetch = false
        errorKind = nil
        optimistic = begin(task.status, next)
        do {
            let updated = try await api.patchTask(task.id, statusPatch(task, next))
            task = updated
            optimistic = commit(optimistic, updated.status)
        } catch let err as DubClientError {
            optimistic = rollback(optimistic)
            if isVersionConflict(err) { needsRefetch = true }
            errorKind = err.kind
        } catch {
            optimistic = rollback(optimistic)
            errorKind = .unknown
        }
    }
}
