// Pure domain helpers: phase-transition rules, DTO mapping, cursor codec.
// EVENT_PHASE_TRANSITIONS is a runtime const in @dub/types (event namespace):
// imported via the namespace value to keep a single source of truth.
import { event as eventNs } from "@dub/types";
import type { event } from "@dub/types";
import type { EventRow, ActionRow, Keyset } from "./types";

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
