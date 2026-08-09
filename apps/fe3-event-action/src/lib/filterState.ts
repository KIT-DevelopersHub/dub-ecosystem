// Filter state <-> URL query sync (test observation #9: filters persist in the
// URL and restore on reload). Pure serialize/parse over URLSearchParams so it is
// unit-tested without a router.
import type { event } from "@dub/types";

export interface EventListFilter {
  phase: event.EventPhase | null;
  includeArchived: boolean;
}

const PHASES: readonly event.EventPhase[] = [
  "planning",
  "preparing",
  "open",
  "live",
  "wrapup",
  "closed",
];

function isPhase(v: string | null): v is event.EventPhase {
  return v !== null && (PHASES as readonly string[]).includes(v);
}

export function parseEventListFilter(search: string | URLSearchParams): EventListFilter {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const phaseRaw = p.get("phase");
  return {
    phase: isPhase(phaseRaw) ? phaseRaw : null,
    includeArchived: p.get("archived") === "1",
  };
}

export function serializeEventListFilter(filter: EventListFilter): string {
  const p = new URLSearchParams();
  if (filter.phase) p.set("phase", filter.phase);
  if (filter.includeArchived) p.set("archived", "1");
  return p.toString();
}

export interface ActionBoardFilter {
  kind: string | null; // action type/kind filter (open registry -> free string)
  status: string | null; // reserved: DubAction has no status field in P0 contract
}

export function parseActionBoardFilter(search: string | URLSearchParams): ActionBoardFilter {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  return {
    kind: p.get("kind"),
    status: p.get("status"),
  };
}

export function serializeActionBoardFilter(filter: ActionBoardFilter): string {
  const p = new URLSearchParams();
  if (filter.kind) p.set("kind", filter.kind);
  if (filter.status) p.set("status", filter.status);
  return p.toString();
}
