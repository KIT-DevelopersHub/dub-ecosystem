// Per-user view state repo (gantt namespace). LWW / no version (§3: single-user
// personal setting, no concurrency semantics). Timestamp via nowIso() only (D2).
import { type DbClient, nowIso } from "@dub/db";
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { gantt, common } from "@dub/types";
import type { ViewRepo } from "./ports";

const ZOOMS: readonly gantt.GanttZoom[] = ["day", "week", "month"];
const DEFAULT_ZOOM: gantt.GanttZoom = "week";

interface Row {
  state: string;
  updated_at: string;
}

function defaultState(eventId: common.EventId): gantt.GanttViewState {
  return { eventId, zoom: DEFAULT_ZOOM, collapsedTaskIds: [] };
}

/** Coerce a persisted/incoming state into a valid frozen GanttViewState. */
/** Keep only string ids and drop duplicates (order preserved). */
function cleanIds(raw: unknown): common.TaskId[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: common.TaskId[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || seen.has(x)) continue;
    seen.add(x);
    out.push(x as common.TaskId);
  }
  return out;
}

function normalize(eventId: common.EventId, raw: unknown): gantt.GanttViewState {
  const o = (raw ?? {}) as Partial<gantt.GanttViewState>;
  const zoom = ZOOMS.includes(o.zoom as gantt.GanttZoom) ? (o.zoom as gantt.GanttZoom) : DEFAULT_ZOOM;
  const collapsed = cleanIds(o.collapsedTaskIds);
  const ordered = cleanIds(o.orderedTaskIds);
  // Only attach orderedTaskIds when non-empty so default states stay byte-identical
  // to the frozen `{ eventId, zoom, collapsedTaskIds }` shape (back-compat).
  return { eventId, zoom, collapsedTaskIds: collapsed, ...(ordered.length > 0 ? { orderedTaskIds: ordered } : {}) };
}

/** Validate the PUT body against the frozen contract (400 on violation). */
export function validatePutBody(body: unknown): gantt.PutGanttViewRequest {
  const o = (body ?? {}) as Partial<gantt.PutGanttViewRequest>;
  if (!ZOOMS.includes(o.zoom as gantt.GanttZoom)) {
    throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "invalid zoom", {
      status: 400,
      details: [{ field: "zoom", reason: "invalid_enum" }],
    });
  }
  if (!Array.isArray(o.collapsedTaskIds) || !o.collapsedTaskIds.every((x) => typeof x === "string")) {
    throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "collapsedTaskIds must be string[]", {
      status: 400,
      details: [{ field: "collapsedTaskIds", reason: "invalid_type" }],
    });
  }
  // orderedTaskIds is additive/optional; when present it must be string[].
  if (o.orderedTaskIds !== undefined && (!Array.isArray(o.orderedTaskIds) || !o.orderedTaskIds.every((x) => typeof x === "string"))) {
    throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "orderedTaskIds must be string[]", {
      status: 400,
      details: [{ field: "orderedTaskIds", reason: "invalid_type" }],
    });
  }
  return {
    zoom: o.zoom as gantt.GanttZoom,
    collapsedTaskIds: o.collapsedTaskIds,
    ...(o.orderedTaskIds !== undefined ? { orderedTaskIds: o.orderedTaskIds } : {}),
  };
}

export function createViewRepo(db: DbClient): ViewRepo {
  return {
    async get(userId, eventId) {
      const row = await db.first<Row>(
        "SELECT state, updated_at FROM gantt_view_states WHERE user_id = ? AND event_id = ?",
        userId,
        eventId,
      );
      if (!row) return defaultState(eventId);
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(row.state);
      } catch {
        parsed = {};
      }
      return normalize(eventId, parsed);
    },

    async put(userId, eventId, req) {
      const state = normalize(eventId, req);
      const json = JSON.stringify(state);
      await db.run(
        `INSERT INTO gantt_view_states (user_id, event_id, state, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, event_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        userId,
        eventId,
        json,
        nowIso(),
      );
      return state;
    },

    async deleteByEvent(eventId) {
      await db.run("DELETE FROM gantt_view_states WHERE event_id = ?", eventId);
    },
  };
}
