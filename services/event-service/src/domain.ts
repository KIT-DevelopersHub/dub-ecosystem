// Pure domain helpers: phase-transition rules, DTO mapping, cursor codec.
// EVENT_PHASE_TRANSITIONS is a runtime const in @dub/types (event namespace):
// imported via the namespace value to keep a single source of truth.
import { event as eventNs } from "@dub/types";
import type { event } from "@dub/types";
import type {
  EventRow,
  ActionRow,
  Keyset,
  EventDetailsData,
  EventDetailLink,
  EventDetailContact,
} from "./types";

// Linear phase order (forward = higher index). Back-transition or ->closed = admin.
const PHASE_ORDER: readonly event.EventPhase[] = [
  "planning",
  "preparing",
  "open",
  "live",
  "wrapup",
  "closed",
];

export function isValidPhaseTransition(from: event.EventPhase, to: event.EventPhase): boolean {
  const allowed = eventNs.EVENT_PHASE_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

/** Transition requiring event:admin: any back-transition, or entering "closed". */
export function phaseTransitionNeedsAdmin(from: event.EventPhase, to: event.EventPhase): boolean {
  if (to === "closed") return true;
  return PHASE_ORDER.indexOf(to) < PHASE_ORDER.indexOf(from);
}

// ---- DTO mappers (row -> frozen wire types) ----
export function toEventSummary(r: EventRow): event.EventSummary {
  return { id: r.id, title: r.title, phase: r.phase, startsAt: r.startsAt };
}

export function toDubEvent(r: EventRow): event.DubEvent {
  return {
    id: r.id,
    orgId: r.orgId,
    title: r.title,
    description: r.description,
    phase: r.phase,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    archivedAt: r.archivedAt,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toDubAction(r: ActionRow): event.DubAction {
  return {
    id: r.id,
    eventId: r.eventId,
    kind: r.kind,
    title: r.title,
    sortOrder: r.sortOrder,
    archivedAt: r.archivedAt,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toActionSummary(r: ActionRow): event.ActionSummary {
  return { id: r.id, eventId: r.eventId, kind: r.kind, title: r.title };
}

export function toEventDetail(e: EventRow, actions: ActionRow[]): event.EventDetail {
  return { ...toDubEvent(e), actions: actions.map(toActionSummary) };
}

// ---- opaque cursor codec (D3: offset paging forbidden; keyset only) ----
export function encodeCursor(k: Keyset): string {
  return btoa(JSON.stringify(k));
}

export function decodeCursor(cursor: string): Keyset | null {
  try {
    const obj = JSON.parse(atob(cursor)) as Keyset;
    if (obj && typeof obj.id === "string") return obj;
    return null;
  } catch {
    return null;
  }
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const INCLUDE_ACTIONS_CAP = 200;
export const SORT_ORDER_GAP = 1024;

// ---- event details (free-form store) ----
export const EMPTY_EVENT_DETAILS: EventDetailsData = {
  overview: "",
  memo: "",
  venue: "",
  links: [],
  contacts: [],
};

// Bounds keep a single row from growing unbounded (the store is convenient, not a CMS).
const MAX_TEXT = 20_000; // overview / memo / venue
const MAX_LIST = 100; // links / contacts
const MAX_FIELD = 500; // per label / url / value

function str(v: unknown, cap: number): string {
  return typeof v === "string" ? v.slice(0, cap) : "";
}

/** Coerce arbitrary client input into a well-formed, bounded EventDetailsData.
 *  Missing keys fall back to the empty defaults so PATCH-like partial saves work. */
export function normalizeEventDetails(input: Partial<EventDetailsData> | undefined): EventDetailsData {
  const links: EventDetailLink[] = Array.isArray(input?.links)
    ? input!.links
        .filter((l): l is EventDetailLink => !!l && typeof l === "object")
        .map((l) => ({ label: str(l.label, MAX_FIELD), url: str(l.url, MAX_FIELD) }))
        .filter((l) => l.label !== "" || l.url !== "")
        .slice(0, MAX_LIST)
    : [];
  const contacts: EventDetailContact[] = Array.isArray(input?.contacts)
    ? input!.contacts
        .filter((c): c is EventDetailContact => !!c && typeof c === "object")
        .map((c) => ({ label: str(c.label, MAX_FIELD), value: str(c.value, MAX_FIELD) }))
        .filter((c) => c.label !== "" || c.value !== "")
        .slice(0, MAX_LIST)
    : [];
  return {
    overview: str(input?.overview, MAX_TEXT),
    memo: str(input?.memo, MAX_TEXT),
    venue: str(input?.venue, MAX_TEXT),
    links,
    contacts,
  };
}
