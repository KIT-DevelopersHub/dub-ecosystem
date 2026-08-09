// Event — event-service shapes the mobile app reads (EventSummary + phase).
// Mirrors packages/types/src/event.ts (consumed subset). "Event > Action" is
// an absolute hierarchy; the app only renders summaries in P0.
import Foundation

public enum EventPhase: String, Codable, Equatable, Sendable, CaseIterable {
    case planning, preparing, open, live, wrapup, closed
}

public struct EventSummary: Codable, Equatable, Sendable, Identifiable {
    public var id: Ids.EventId
    public var title: String
    public var phase: EventPhase
    public var startsAt: ISODateTime?
    public init(id: Ids.EventId, title: String, phase: EventPhase, startsAt: ISODateTime?) {
        self.id = id
        self.title = title
        self.phase = phase
        self.startsAt = startsAt
    }
}
