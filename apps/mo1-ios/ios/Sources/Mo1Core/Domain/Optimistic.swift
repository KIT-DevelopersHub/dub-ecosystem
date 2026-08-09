// Optimistic — task state-change optimistic UI (design §1, §5 S5, §6 CONFLICT),
// mirrors optimistic.ts. PATCH carries `version`; a mismatch returns 409
// *_VERSION_CONFLICT and the UI rolls back to the pre-edit snapshot. Pure
// functions so the ViewModel and its tests share one implementation.
import Foundation

/// Is `to` reachable from `from` per the frozen transition table?
public func canTransition(_ from: TaskStatus, _ to: TaskStatus) -> Bool {
    if from == to { return true }
    return TASK_STATUS_TRANSITIONS[from]?.contains(to) ?? false
}

public struct OptimisticState<T: Equatable>: Equatable {
    /// what the UI renders right now (optimistic value while pending).
    public let value: T
    /// snapshot to restore on failure; nil when settled.
    public let rollbackTo: T?
    public let pending: Bool
    public init(value: T, rollbackTo: T?, pending: Bool) {
        self.value = value; self.rollbackTo = rollbackTo; self.pending = pending
    }
}

public func settled<T>(_ value: T) -> OptimisticState<T> {
    OptimisticState(value: value, rollbackTo: nil, pending: false)
}

/// Begin an optimistic edit: show `next`, remember `current` for rollback.
public func begin<T>(_ current: T, _ next: T) -> OptimisticState<T> {
    OptimisticState(value: next, rollbackTo: current, pending: true)
}

/// Server confirmed: adopt the authoritative value, drop the snapshot.
public func commit<T>(_ state: OptimisticState<T>, _ confirmed: T) -> OptimisticState<T> {
    settled(confirmed)
}

/// Server rejected: restore the snapshot (no-op if already settled).
public func rollback<T>(_ state: OptimisticState<T>) -> OptimisticState<T> {
    guard state.pending, let snapshot = state.rollbackTo else { return settled(state.value) }
    return settled(snapshot)
}

/// A 409 (incl. open *_VERSION_CONFLICT codes) means "rollback + refetch".
public func isVersionConflict(_ err: DubClientError) -> Bool {
    err.kind == .conflict
}

/// Build the PATCH body for a status change with the optimistic-lock version.
public func statusPatch(_ current: DubTask, _ status: TaskStatus) -> UpdateTaskRequest {
    UpdateTaskRequest(version: current.version, status: status)
}
