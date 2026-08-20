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

// Action list contract (migrated here from fe3 actionContracts.ts per its GAP NOTE, so
// the query keys have a canonical SoT the wire contract below can bind to).
export interface ListActionsQuery extends CursorQuery {
  kind?: string;
  includeArchived?: boolean; // event-service reads it (q.includeArchived); additive.
}
export type ListActionsResponse = Paginated<DubAction>;

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* each event-service read
// endpoint puts on the wire. The FE client (apps/fe3 eventApi.ts), the server
// (event-service app.ts) and the OpenAPI spec (docs/openapi/event-service.yaml) all
// derive from — and are reconciled against — this one map in CI (see @dub/e2e-smoke
// wire-params.test.ts). Renaming a key here is the ONLY legitimate way to change a wire
// param; any side that disagrees turns a contract-conformance test red (unmergeable).
// `path` is the gateway path AFTER the /api/v1 prefix strip. See
// docs/api-contracts/_wire-contract-enforcement.md — do not hand-map keys elsewhere.
export const EVENT_WIRE = {
  listEvents: {
    method: "GET",
    path: "/events",
    query: ["cursor", "limit", "phase", "startsAfter", "sort", "includeArchived"],
  },
  listActions: {
    method: "GET",
    path: "/events/{id}/actions",
    query: ["cursor", "limit", "kind", "includeArchived"],
  },
} as const;

// Compile-time tie between the runtime descriptor and the typed query interfaces: every
// query key each endpoint lists must be a real key of its query type, so the descriptor
// and the hand-written types can never silently drift from each other.
type _EventWireKeysAreTyped =
  (typeof EVENT_WIRE.listEvents.query)[number] extends keyof ListEventsQuery
    ? (typeof EVENT_WIRE.listActions.query)[number] extends keyof ListActionsQuery
      ? true
      : never
    : never;
const _eventWireKeyGuard: _EventWireKeysAreTyped = true;
void _eventWireKeyGuard;
