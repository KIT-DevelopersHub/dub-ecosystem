// Per-user persistence of the gantt VIEW dimensions — display granularity (zoom),
// the status filter, the team selection, and the "アーカイブ含む" toggle. Like the
// sort mode and task-number prefs, these are personal client-side view preferences
// (they change only what's on screen, not stored data), so they live in localStorage
// keyed by event — no server round-trip, no contract change, $0. localStorage is
// already per-browser (≈ per-user), so per-event keying matches the existing
// useGanttSort / useTaskNumberPrefix convention.
import type { common, gantt, task } from "@dub/types";
import { emptyFilter, type TaskFilterState } from "./task-query";

const ZOOMS: readonly gantt.GanttZoom[] = ["month", "week", "day"];
const ALL_STATUS: readonly task.TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

/** Default zoom — matches the pre-persistence hard-coded "week". */
export const DEFAULT_ZOOM: gantt.GanttZoom = "week";

/** The persisted view preference. `teamId` absent = 全体表示 (all teams). */
export interface GanttViewPref {
  zoom: gantt.GanttZoom;
  status: task.TaskStatus[];
  teamId?: common.TeamId;
  includeArchived: boolean;
}

/** The defaults: week zoom, no status narrowing, all teams, archives hidden. */
export function defaultViewPref(): GanttViewPref {
  return { zoom: DEFAULT_ZOOM, status: [], includeArchived: false };
}

function isZoom(v: unknown): v is gantt.GanttZoom {
  return typeof v === "string" && (ZOOMS as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is task.TaskStatus {
  return typeof v === "string" && (ALL_STATUS as readonly string[]).includes(v);
}

function storageKey(eventId: common.EventId): string {
  return `fe4:gantt-view-pref:${eventId}`;
}

/** Coerce arbitrary parsed JSON into a valid preference — unknown fields fall back
 *  to their default so a partial/garbage payload never breaks the view. */
function coerce(raw: unknown): GanttViewPref {
  if (!raw || typeof raw !== "object") return defaultViewPref();
  const obj = raw as {
    zoom?: unknown;
    status?: unknown;
    teamId?: unknown;
    includeArchived?: unknown;
  };
  const status = Array.isArray(obj.status)
    ? obj.status.filter(isStatus).filter((s, i, all) => all.indexOf(s) === i)
    : [];
  const teamId =
    typeof obj.teamId === "string" && obj.teamId.length > 0
      ? (obj.teamId as common.TeamId)
      : undefined;
  return {
    zoom: isZoom(obj.zoom) ? obj.zoom : DEFAULT_ZOOM,
    status,
    ...(teamId !== undefined ? { teamId } : {}),
    includeArchived: obj.includeArchived === true,
  };
}

/** Read the saved preference (defaults when nothing/garbage is stored); tolerant of
 *  no/blocked storage. */
export function loadViewPref(eventId: common.EventId): GanttViewPref {
  try {
    const rawStr = globalThis.localStorage?.getItem(storageKey(eventId));
    if (rawStr == null) return defaultViewPref();
    return coerce(JSON.parse(rawStr));
  } catch {
    return defaultViewPref();
  }
}

/** Persist the preference; silently no-ops when storage is unavailable. */
export function saveViewPref(eventId: common.EventId, pref: GanttViewPref): void {
  try {
    globalThis.localStorage?.setItem(storageKey(eventId), JSON.stringify(pref));
  } catch {
    /* storage blocked (private mode / quota) — the in-memory state still applies */
  }
}

/** Drop the saved preference (used by the "表示をリセット" action). */
export function clearViewPref(eventId: common.EventId): void {
  try {
    globalThis.localStorage?.removeItem(storageKey(eventId));
  } catch {
    /* storage blocked — nothing to clear */
  }
}

/** Seed a TaskFilterState from a saved preference — the persistence-aware
 *  replacement for `emptyFilter(eventId)` at mount / event switch. Only the
 *  persisted view dimensions (status / team / archive) are applied; pagination
 *  (cursor/limit) and assignee stay ephemeral. */
export function filterFromPref(
  eventId: common.EventId,
  pref: GanttViewPref,
): TaskFilterState {
  return {
    ...emptyFilter(eventId),
    status: [...pref.status],
    ...(pref.teamId !== undefined ? { teamId: pref.teamId } : {}),
    includeArchived: pref.includeArchived,
  };
}

/** Project the live zoom + filter back into a persistable preference. */
export function prefFromView(
  zoom: gantt.GanttZoom,
  filter: TaskFilterState,
): GanttViewPref {
  return {
    zoom,
    status: [...filter.status],
    ...(filter.teamId !== undefined ? { teamId: filter.teamId } : {}),
    includeArchived: filter.includeArchived,
  };
}
