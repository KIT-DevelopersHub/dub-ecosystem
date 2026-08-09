// event — event-service namespace. "Event > Action" hierarchy is absolute.
import type { EventId, ActionId, OrgId, ISODateTime, Versioned, Paginated, CursorQuery } from "./common";

// EventPhase: closed union (D6). Change = contract-change process.
export type EventPhase = "planning" | "preparing" | "open" | "live" | "wrapup" | "closed";

// Phase transition table (server validation + FE3 PhaseTransitionControl single source).
// Forward (next adjacent) = event:write; wrapup->closed and back-transitions = event:admin.
// No transition out of closed (no reopen).
export const EVENT_PHASE_TRANSITIONS: Record<EventPhase, readonly EventPhase[]> = {
  planning: ["preparing"],
  preparing: ["open", "planning"],
  open: ["live", "preparing"],
  live: ["wrapup", "open"],
  wrapup: ["closed", "live"],
  closed: [],
};

export interface DubEvent extends Versioned {
  id: EventId;
  orgId: OrgId;
  title: string;
  description: string | null;
  phase: EventPhase;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  archivedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface DubAction extends Versioned {
  id: ActionId;
  eventId: EventId;
  kind: string; // action type (open registry; new types allowed freely)
  title: string;
  sortOrder: number;
  archivedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// Summary/Detail owned here (D9); gateway/MO3 compose only.
export interface EventSummary {
  id: EventId;
  title: string;
  phase: EventPhase;
  startsAt: ISODateTime | null;
}
export interface EventDetail extends DubEvent {
  actions: ActionSummary[];
}
export interface ActionSummary {
  id: ActionId;
  eventId: EventId;
  kind: string;
  title: string;
}

export interface CreateEventRequest {
  title: string;
  description?: string;
  startsAt?: ISODateTime;
  endsAt?: ISODateTime;
}
export interface UpdateEventRequest extends Versioned {
  title?: string;
  description?: string | null;
  phase?: EventPhase; // validated against EVENT_PHASE_TRANSITIONS
  startsAt?: ISODateTime | null;
  endsAt?: ISODateTime | null;
}
export interface ListEventsQuery extends CursorQuery {
  phase?: EventPhase;
  startsAfter?: ISODateTime;
  sort?: "startsAt";
  includeArchived?: boolean;
}
export type ListEventsResponse = Paginated<EventSummary>;
export type GetEventResponse = EventDetail;
