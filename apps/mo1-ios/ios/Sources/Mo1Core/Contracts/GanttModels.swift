// Gantt — gantt-service + gantt-calc shapes the S6 GanttView reads. Mirrors the
// consumed subset of packages/types/src/gantt.ts and gantt-calc.ts. The mobile
// app renders the frozen `GanttChartDTO` (rows + FS dependency lines); the
// dependency ordering / date window is derived by the pure Domain/Gantt.swift
// layer over the `GanttCalc*` shapes (the same contract task-service rolls up).
import Foundation

public enum GanttZoom: String, Codable, Equatable, Sendable, CaseIterable {
    case day, week, month
}

public struct GanttRow: Codable, Equatable, Sendable, Identifiable {
    public var taskId: Ids.TaskId
    public var title: String
    public var startsAt: ISODateTime?
    public var endsAt: ISODateTime?
    /// 0-100 (done=100 / else=0 in P0).
    public var progressPercent: Int
    public var assigneeId: Ids.UserId?
    public var id: Ids.TaskId { taskId }
    public init(
        taskId: Ids.TaskId, title: String, startsAt: ISODateTime?, endsAt: ISODateTime?,
        progressPercent: Int, assigneeId: Ids.UserId?
    ) {
        self.taskId = taskId; self.title = title; self.startsAt = startsAt
        self.endsAt = endsAt; self.progressPercent = progressPercent; self.assigneeId = assigneeId
    }
}

public struct GanttDependencyLine: Codable, Equatable, Sendable, Identifiable {
    /// composite key `${taskId}->${dependsOnId}`.
    public var id: String
    public var fromTaskId: Ids.TaskId
    public var toTaskId: Ids.TaskId
    /// P0 constant "FS".
    public var type: String
    /// P0 constant 0.
    public var lagDays: Int
    public init(id: String, fromTaskId: Ids.TaskId, toTaskId: Ids.TaskId, type: String = "FS", lagDays: Int = 0) {
        self.id = id; self.fromTaskId = fromTaskId; self.toTaskId = toTaskId
        self.type = type; self.lagDays = lagDays
    }
}

public struct GanttChartDTO: Codable, Equatable, Sendable {
    public var eventId: Ids.EventId
    public var rows: [GanttRow]
    public var dependencies: [GanttDependencyLine]
    public init(eventId: Ids.EventId, rows: [GanttRow], dependencies: [GanttDependencyLine]) {
        self.eventId = eventId; self.rows = rows; self.dependencies = dependencies
    }
}

public struct GanttViewState: Codable, Equatable, Sendable {
    public var eventId: Ids.EventId
    public var zoom: GanttZoom
    public var collapsedTaskIds: [Ids.TaskId]
    public init(eventId: Ids.EventId, zoom: GanttZoom, collapsedTaskIds: [Ids.TaskId]) {
        self.eventId = eventId; self.zoom = zoom; self.collapsedTaskIds = collapsedTaskIds
    }
}

public struct GetGanttQuery: Equatable, Sendable {
    public var eventId: Ids.EventId
    public init(eventId: Ids.EventId) { self.eventId = eventId }
}

public struct PutGanttViewRequest: Codable, Equatable, Sendable {
    public var zoom: GanttZoom
    public var collapsedTaskIds: [Ids.TaskId]
    public init(zoom: GanttZoom, collapsedTaskIds: [Ids.TaskId]) {
        self.zoom = zoom; self.collapsedTaskIds = collapsedTaskIds
    }
}

// ---- gantt-calc (pure computation shapes) ----------------------------------

public struct GanttCalcTask: Codable, Equatable, Sendable, Identifiable {
    public var id: Ids.TaskId
    public var startsAt: ISODateTime?
    public var endsAt: ISODateTime?
    public var durationDays: Int
    public init(id: Ids.TaskId, startsAt: ISODateTime?, endsAt: ISODateTime?, durationDays: Int) {
        self.id = id; self.startsAt = startsAt; self.endsAt = endsAt; self.durationDays = durationDays
    }
}

/// Predecessor = `dependsOnId`, successor = `taskId`. Omitted kind => FS.
public struct GanttCalcDependency: Codable, Equatable, Sendable {
    public var taskId: Ids.TaskId
    public var dependsOnId: Ids.TaskId
    public var kind: String?
    public var lagDays: Int?
    public init(taskId: Ids.TaskId, dependsOnId: Ids.TaskId, kind: String? = nil, lagDays: Int? = nil) {
        self.taskId = taskId; self.dependsOnId = dependsOnId; self.kind = kind; self.lagDays = lagDays
    }
}
