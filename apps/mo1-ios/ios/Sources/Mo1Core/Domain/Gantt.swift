// Gantt — GanttView (S6) view-model over the frozen gantt / gantt-calc shapes
// (design §2-1 S6), mirrors gantt.ts. Derives the two things the Swift
// GanttViewModel and its tests must agree on:
//   1. 依存順序 — a stable dependency (topological) ordering + per-row depth,
//      with cycle detection that degrades to source order (never throws).
//   2. 日付レンジ — the chart date window and each row's day offset/duration.
// Pure functions so the ViewModel and its tests share one implementation.
import Foundation

private let DAY_MS: Double = 86_400_000

// ISO8601 with fractional-second tolerance (matches JS Date.parse leniency for
// the "…Z" / "…±hh:mm" shapes the BFF emits).
private let Self_isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let Self_isoFormatterNoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private func parseIsoMs(_ s: String) -> Double? {
    if let d = Self_isoFormatter.date(from: s) { return d.timeIntervalSince1970 * 1000 }
    if let d = Self_isoFormatterNoFrac.date(from: s) { return d.timeIntervalSince1970 * 1000 }
    return nil
}

/// Whole-day difference b - a (ISO8601). Non-parseable inputs collapse to 0.
public func dayDiff(_ a: String, _ b: String) -> Int {
    guard let ta = parseIsoMs(a), let tb = parseIsoMs(b) else { return 0 }
    return Int((( tb - ta) / DAY_MS).rounded())
}

public struct GanttDateRange: Equatable, Sendable {
    /// earliest row start (ISO8601), or nil when nothing is scheduled.
    public let start: String?
    /// latest row end (ISO8601), or nil when nothing is scheduled.
    public let end: String?
    /// inclusive span in days (0 when unscheduled or single-day).
    public let totalDays: Int
    public init(start: String?, end: String?, totalDays: Int) {
        self.start = start; self.end = end; self.totalDays = totalDays
    }
}

public struct DependencyOrder: Equatable, Sendable {
    /// task ids in dependency order (predecessors before successors).
    public let order: [Ids.TaskId]
    /// longest-path depth from a dependency-free root (root = 0).
    public let depth: [Ids.TaskId: Int]
    /// true when the dependency graph has a cycle (order falls back to source).
    public let hasCycle: Bool
    public init(order: [Ids.TaskId], depth: [Ids.TaskId: Int], hasCycle: Bool) {
        self.order = order; self.depth = depth; self.hasCycle = hasCycle
    }
}

/// Stable topological order of `tasks` under `dependencies` (Kahn's algorithm).
/// The edge points `dependsOnId -> taskId`. Dependencies touching unknown tasks
/// (or self-loops) are ignored. On a cycle the un-orderable remainder is
/// appended in source order and `hasCycle` is set (never throws — design §6).
public func dependencyOrder(
    _ tasks: [GanttCalcTask],
    _ dependencies: [GanttCalcDependency]
) -> DependencyOrder {
    let ids = tasks.map { $0.id }
    let known = Set(ids)
    var indegree: [Ids.TaskId: Int] = [:]
    var successors: [Ids.TaskId: [Ids.TaskId]] = [:]
    for id in ids { indegree[id] = 0; successors[id] = [] }

    for dep in dependencies {
        guard known.contains(dep.taskId), known.contains(dep.dependsOnId), dep.taskId != dep.dependsOnId else { continue }
        successors[dep.dependsOnId, default: []].append(dep.taskId)
        indegree[dep.taskId, default: 0] += 1
    }

    var depth: [Ids.TaskId: Int] = [:]
    for id in ids { depth[id] = 0 }

    // Seed the queue in source order so equal-rank rows keep their input order.
    var queue = ids.filter { indegree[$0] == 0 }
    var order: [Ids.TaskId] = []
    var head = 0
    while head < queue.count {
        let id = queue[head]; head += 1
        order.append(id)
        for next in successors[id] ?? [] {
            depth[next] = max(depth[next] ?? 0, (depth[id] ?? 0) + 1)
            let left = (indegree[next] ?? 0) - 1
            indegree[next] = left
            if left == 0 { queue.append(next) }
        }
    }

    if order.count < ids.count {
        let placed = Set(order)
        for id in ids where !placed.contains(id) { order.append(id) }
        return DependencyOrder(order: order, depth: depth, hasCycle: true)
    }
    return DependencyOrder(order: order, depth: depth, hasCycle: false)
}

/// Chart window across the scheduled `tasks` (unscheduled rows are skipped).
public func dateRange(_ tasks: [GanttCalcTask]) -> GanttDateRange {
    var start: String? = nil
    var end: String? = nil
    for t in tasks {
        if let s = t.startsAt, let sms = parseIsoMs(s) {
            if start == nil || sms < (parseIsoMs(start!) ?? .greatestFiniteMagnitude) { start = s }
        }
        if let e = t.endsAt, let ems = parseIsoMs(e) {
            if end == nil || ems > (parseIsoMs(end!) ?? -.greatestFiniteMagnitude) { end = e }
        }
    }
    let totalDays = (start != nil && end != nil) ? max(0, dayDiff(start!, end!)) : 0
    return GanttDateRange(start: start, end: end, totalDays: totalDays)
}

// ---- view-model ------------------------------------------------------------

/// One placed Gantt row (mirrors gantt.ts `GanttViewRow`).
public struct GanttViewRow: Equatable, Sendable, Identifiable {
    public var taskId: Ids.TaskId
    public var title: String
    public var startsAt: ISODateTime?
    public var endsAt: ISODateTime?
    public var progressPercent: Int
    public var assigneeId: Ids.UserId?
    /// dependency depth (0 = no predecessors).
    public var depth: Int
    /// day offset of the bar from `range.start`; nil when unscheduled.
    public var offsetDays: Int?
    /// bar length in days (0 when unscheduled / single-day).
    public var durationDays: Int
    /// mirrors the persisted collapsedTaskIds so the UI can fold rows.
    public var collapsed: Bool
    public var id: Ids.TaskId { taskId }
    public init(
        taskId: Ids.TaskId, title: String, startsAt: ISODateTime?, endsAt: ISODateTime?,
        progressPercent: Int, assigneeId: Ids.UserId?, depth: Int, offsetDays: Int?,
        durationDays: Int, collapsed: Bool
    ) {
        self.taskId = taskId; self.title = title; self.startsAt = startsAt; self.endsAt = endsAt
        self.progressPercent = progressPercent; self.assigneeId = assigneeId; self.depth = depth
        self.offsetDays = offsetDays; self.durationDays = durationDays; self.collapsed = collapsed
    }
}

/// Built GanttView view-model data (mirrors gantt.ts `GanttViewModel` interface;
/// named `GanttViewData` to avoid colliding with the Mo1UI ObservableObject).
public struct GanttViewData: Equatable, Sendable {
    public var eventId: Ids.EventId
    public var zoom: GanttZoom
    public var range: GanttDateRange
    /// rows in dependency order.
    public var rows: [GanttViewRow]
    public var dependencies: [GanttDependencyLine]
    public var hasCycle: Bool
    public var collapsedTaskIds: [Ids.TaskId]
    public init(
        eventId: Ids.EventId, zoom: GanttZoom, range: GanttDateRange, rows: [GanttViewRow],
        dependencies: [GanttDependencyLine], hasCycle: Bool, collapsedTaskIds: [Ids.TaskId]
    ) {
        self.eventId = eventId; self.zoom = zoom; self.range = range; self.rows = rows
        self.dependencies = dependencies; self.hasCycle = hasCycle; self.collapsedTaskIds = collapsedTaskIds
    }
}

/// Persisted GanttViewState fields the builder honours.
public struct GanttViewOptions: Equatable, Sendable {
    public var zoom: GanttZoom?
    public var collapsedTaskIds: [Ids.TaskId]
    public init(zoom: GanttZoom? = nil, collapsedTaskIds: [Ids.TaskId] = []) {
        self.zoom = zoom; self.collapsedTaskIds = collapsedTaskIds
    }
}

private func toCalcTask(_ row: GanttRow) -> GanttCalcTask {
    let duration = (row.startsAt != nil && row.endsAt != nil) ? max(0, dayDiff(row.startsAt!, row.endsAt!)) : 0
    return GanttCalcTask(id: row.taskId, startsAt: row.startsAt, endsAt: row.endsAt, durationDays: duration)
}

/// An FS line ("from finishes before to starts") = "to depends on from".
private func toCalcDependency(_ line: GanttDependencyLine) -> GanttCalcDependency {
    GanttCalcDependency(taskId: line.toTaskId, dependsOnId: line.fromTaskId)
}

/// Build the GanttView view-model from the frozen chart DTO: order rows by their
/// FS dependencies, compute the date window, and place each bar within it.
public func buildGanttViewData(_ dto: GanttChartDTO, options: GanttViewOptions = GanttViewOptions()) -> GanttViewData {
    let calcTasks = dto.rows.map(toCalcTask)
    let calcDeps = dto.dependencies.map(toCalcDependency)

    let ordering = dependencyOrder(calcTasks, calcDeps)
    let range = dateRange(calcTasks)
    let collapsed = Set(options.collapsedTaskIds)
    var byId: [Ids.TaskId: GanttRow] = [:]
    for r in dto.rows { byId[r.taskId] = r }

    let rows: [GanttViewRow] = ordering.order.compactMap { id in
        guard let r = byId[id] else { return nil }
        let duration = (r.startsAt != nil && r.endsAt != nil) ? max(0, dayDiff(r.startsAt!, r.endsAt!)) : 0
        let offset: Int? = (range.start != nil && r.startsAt != nil) ? dayDiff(range.start!, r.startsAt!) : nil
        return GanttViewRow(
            taskId: r.taskId, title: r.title, startsAt: r.startsAt, endsAt: r.endsAt,
            progressPercent: r.progressPercent, assigneeId: r.assigneeId,
            depth: ordering.depth[id] ?? 0, offsetDays: offset, durationDays: duration,
            collapsed: collapsed.contains(id))
    }

    return GanttViewData(
        eventId: dto.eventId,
        zoom: options.zoom ?? .week,
        range: range,
        rows: rows,
        dependencies: dto.dependencies,
        hasCycle: ordering.hasCycle,
        collapsedTaskIds: Array(collapsed))
}

/// Persist body for the current view-model (design: PUT gantt view state).
public func toPutGanttViewRequest(zoom: GanttZoom, collapsedTaskIds: [Ids.TaskId]) -> PutGanttViewRequest {
    PutGanttViewRequest(zoom: zoom, collapsedTaskIds: collapsedTaskIds)
}
