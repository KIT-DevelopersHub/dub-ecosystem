// gantt — gantt-service namespace (view states; read model over task/event).
import type { EventId, TaskId, UserId, TeamId, ISODateTime } from "./common";
import type { TaskCrossRole, TaskCrossLink } from "./task";

export type GanttZoom = "day" | "week" | "month";

export interface GanttRow {
  taskId: TaskId;
  title: string;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  progressPercent: number; // 0-100 (done=100/else=0 in P0)
  assigneeId: UserId | null;
  /** Owning team (canonical team.Team), for team-scoped views. Additive. */
  teamId?: TeamId | null;
  /** Creation timestamp of the underlying task. This is the STABLE basis for the
   *  task's global creation-order ID number: numbering sorts rows by this (not by
   *  display order), so filtering / sorting / re-ordering the gantt never re-numbers
   *  a task. Additive/optional — absent ⇒ numbering falls back to taskId order. */
  createdAt?: ISODateTime;
  /** When set, overrides `createdAt` as the ID-sequence basis. It is re-stamped to
   *  "now" whenever a task's owning team changes, so a team change retires the old
   *  ID and re-numbers the task at the TAIL of the global sequence under the new
   *  team's prefix (= "delete old task + create a new one" semantics). Additive. */
  idSeqAt?: ISODateTime | null;
  /** Absolute, monotonically-increasing creation sequence number (never reused). When
   *  present it fixes the numeric part of the task's ID directly, so it is a truly
   *  stable attribute: deleting or re-teaming another task never shifts this one's
   *  number. A team change assigns a fresh (tail) seqNo. Absent (e.g. a backend not yet
   *  projecting it) ⇒ numbering falls back to a dense rank over createdAt/idSeqAt, which
   *  is still stable under filter/sort/reorder. Additive/optional. */
  seqNo?: number;
  /** WBS hierarchy (all additive/optional; absent ⇒ a flat top-level row).
   *  A row whose `parentTaskId` points at another row is a child (WBS leaf) of
   *  that work-package; the UI indents it and hides it when the parent collapses. */
  parentTaskId?: TaskId | null;
  /** Depth in the WBS tree: 0 = work-package (top-level), 1 = leaf. */
  depth?: number;
  /** True when at least one other row lists this row as its `parentTaskId`
   *  (the UI renders a collapse/expand toggle for it). */
  hasChildren?: boolean;
  /** WBS code (e.g. "4.9.3"), for stable ordering + a legible row label. */
  wbs?: string;
  /** Cross-team role for the「送る・受け取る」badge (ADR-0007). additive/optional;
   *  absent/null ⇒ no cross-team link on this row. `requested` = お願いした side,
   *  `accepted` = 受け負った side. The gantt draws NO arrow for this — it is projected
   *  from task_cross_links (not task_dependencies), so CPM never sees it; the row just
   *  shows a status badge whose label is derived from the role (never stored). */
  crossTeamRole?: TaskCrossRole | null;
}

export interface GanttDependencyLine {
  id: string; // composite key `${taskId}->${dependsOnId}`
  fromTaskId: TaskId;
  toTaskId: TaskId;
  type: "FS"; // P0 constant fill
  lagDays: number; // P0 constant 0
}

export interface GanttChartDTO {
  eventId: EventId;
  rows: GanttRow[];
  dependencies: GanttDependencyLine[];
  /** Zero-slack tasks on the critical path (CPM over durations+FS deps). Optional
   *  & additive: absent/[] means "not computed" — UI colors these bars distinctly. */
  criticalTaskIds?: TaskId[];
  /** Cross-team links (送る・受け取る) for this event — a SEPARATE channel from
   *  `dependencies` precisely so the gantt does not draw them as arrows. additive/
   *  optional: absent/[] ⇒ none. The UI reads these to place role badges on rows. */
  crossLinks?: TaskCrossLink[];
}

export interface GanttViewState {
  eventId: EventId;
  zoom: GanttZoom;
  collapsedTaskIds: TaskId[];
  /** Manual row order (per-user personal ordering set by drag-and-drop in the left
   *  pane). Additive/optional: absent ⇒ the server's WBS/title ordering is used. A
   *  task id appearing here pins its position within its sibling group; ids not
   *  listed keep the default order after the listed ones. Persisted in the same
   *  per-user view-state JSON blob (no schema change). */
  orderedTaskIds?: TaskId[];
}
export interface GetGanttQuery {
  eventId: EventId;
}
/** Body of PATCH /gantt/rows/:taskId — persist a bar's window after a timeline
 *  drag/resize or a start/due edit. gantt-service maps startsAt → the task's
 *  startAt and endsAt → the task's dueAt (read-modify-write, optimistic-locked
 *  upstream). Either value may be null to clear that edge. */
export interface PatchGanttRowRequest {
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
}
export interface PutGanttViewRequest {
  zoom: GanttZoom;
  collapsedTaskIds: TaskId[];
  /** Manual row order (see GanttViewState.orderedTaskIds). Additive/optional. */
  orderedTaskIds?: TaskId[];
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* every gantt read endpoint
// puts on the wire. The FE client (apps/fe4 endpoints.ts), the server (gantt-service),
// and the OpenAPI spec (docs/openapi/gantt-service.yaml) all derive from — and are
// reconciled against — this one map in CI. This is the guard the `?event` vs `?eventId`
// production drift needed: renaming a key here is the ONLY legitimate way to change a
// wire param; any side that disagrees turns a contract-conformance test red (unmergeable).
// `path` is the gateway path AFTER the /api/v1 prefix strip. Extend per-service the same
// way (see docs/api-contracts/_wire-contract-enforcement.md) — do not hand-map keys.
export const GANTT_WIRE = {
  getGantt: { method: "GET", path: "/gantt", query: ["eventId"] },
  getGanttDependencies: { method: "GET", path: "/gantt/dependencies", query: ["eventId"] },
  getGanttView: { method: "GET", path: "/gantt/views", query: ["eventId"] },
  putGanttView: { method: "PUT", path: "/gantt/views", query: ["eventId"] },
} as const;

// Compile-time tie between the runtime descriptor and the typed query interface: every
// query key the descriptor lists must be a real key of GetGanttQuery, so the descriptor
// and the hand-written type can never silently drift from each other.
type _GanttWireKeysAreTyped =
  (typeof GANTT_WIRE)[keyof typeof GANTT_WIRE]["query"][number] extends keyof GetGanttQuery ? true : never;
const _ganttWireKeyGuard: _GanttWireKeysAreTyped = true;
void _ganttWireKeyGuard;
