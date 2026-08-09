// Task — task-service shapes + the frozen status-transition table (the single
// source FE4 and the mobile UI share). Mirrors packages/types/src/task.ts.
import Foundation

public enum TaskStatus: String, Codable, Equatable, Sendable, CaseIterable {
    case todo
    case inProgress = "in_progress"
    case blocked
    case done
    case cancelled
}

public enum TaskPriority: String, Codable, Equatable, Sendable {
    case low, medium, high, urgent
}

public enum TaskOrigin: String, Codable, Equatable, Sendable {
    case internalOrigin = "internal"
    case github
}

/// Status transition table (server validation + UI activation single source).
/// `from == to` is always allowed (handled by `canTransition`).
public let TASK_STATUS_TRANSITIONS: [TaskStatus: [TaskStatus]] = [
    .todo: [.inProgress, .blocked, .done, .cancelled],
    .inProgress: [.todo, .blocked, .done, .cancelled],
    .blocked: [.todo, .inProgress, .cancelled], // done only via in_progress
    .done: [.inProgress],                        // reopen
    .cancelled: [.todo],                         // reopen
]

public struct DubTask: Codable, Equatable, Sendable, Identifiable {
    public var id: Ids.TaskId
    public var eventId: Ids.EventId
    public var title: String
    public var description: String?
    public var status: TaskStatus
    public var priority: TaskPriority
    public var assigneeId: Ids.UserId?
    public var dueAt: ISODateTime?
    public var origin: TaskOrigin
    public var archivedAt: ISODateTime?
    public var createdAt: ISODateTime
    public var updatedAt: ISODateTime
    public var version: Int

    public init(
        id: Ids.TaskId, eventId: Ids.EventId, title: String, description: String?,
        status: TaskStatus, priority: TaskPriority, assigneeId: Ids.UserId?,
        dueAt: ISODateTime?, origin: TaskOrigin, archivedAt: ISODateTime?,
        createdAt: ISODateTime, updatedAt: ISODateTime, version: Int
    ) {
        self.id = id; self.eventId = eventId; self.title = title
        self.description = description; self.status = status; self.priority = priority
        self.assigneeId = assigneeId; self.dueAt = dueAt; self.origin = origin
        self.archivedAt = archivedAt; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.version = version
    }
}

public struct TaskSummary: Codable, Equatable, Sendable, Identifiable {
    public var id: Ids.TaskId
    public var title: String
    public var status: TaskStatus
    public var assigneeId: Ids.UserId?
    public init(id: Ids.TaskId, title: String, status: TaskStatus, assigneeId: Ids.UserId?) {
        self.id = id; self.title = title; self.status = status; self.assigneeId = assigneeId
    }
}

/// PATCH body — always carries `version` for optimistic locking (no mobile
/// exception, D4). Nil optionals are omitted by the synthesized encoder, so a
/// status-only patch serializes to `{ "version": N, "status": "..." }`.
public struct UpdateTaskRequest: Codable, Equatable, Sendable {
    public var version: Int
    public var title: String?
    public var description: String?
    public var status: TaskStatus?
    public var priority: TaskPriority?
    public var assigneeId: Ids.UserId?
    public var dueAt: ISODateTime?
    public init(
        version: Int, title: String? = nil, description: String? = nil,
        status: TaskStatus? = nil, priority: TaskPriority? = nil,
        assigneeId: Ids.UserId? = nil, dueAt: ISODateTime? = nil
    ) {
        self.version = version; self.title = title; self.description = description
        self.status = status; self.priority = priority
        self.assigneeId = assigneeId; self.dueAt = dueAt
    }
}

public struct ListTasksQuery: Equatable, Sendable {
    public var cursor: String?
    public var limit: Int?
    public var eventId: Ids.EventId?
    public var assigneeId: Ids.UserId?
    public init(cursor: String? = nil, limit: Int? = nil, eventId: Ids.EventId? = nil, assigneeId: Ids.UserId? = nil) {
        self.cursor = cursor; self.limit = limit; self.eventId = eventId; self.assigneeId = assigneeId
    }
}

public typealias ListTasksResponse = Paginated<DubTask>
