// gantt — gantt-service namespace (view states; read model over task/event).
import type { EventId, TaskId, UserId, TeamId, ISODateTime } from "./common";

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
  getGanttWsTicket: { method: "GET", path: "/gantt/ws-ticket", query: ["eventId"] },
} as const;

// Compile-time tie between the runtime descriptor and the typed query interface: every
// query key the descriptor lists must be a real key of GetGanttQuery, so the descriptor
// and the hand-written type can never silently drift from each other.
type _GanttWireKeysAreTyped =
  (typeof GANTT_WIRE)[keyof typeof GANTT_WIRE]["query"][number] extends keyof GetGanttQuery ? true : never;
const _ganttWireKeyGuard: _GanttWireKeysAreTyped = true;
void _ganttWireKeyGuard;

// ── Realtime (Durable Object + WebSocket) ────────────────────────────────────
// gantt-service fans these out to every socket in an event's GanttRoom DO after a
// write COMMITS (RT never leads the source of truth). This is BOTH the server-internal
// fanout contract AND the client WS wire contract (frozen — mirror any change on both
// sides). Delta-only by design (コスト最小化 / 判断66): a bar move ships just the moved
// window (`row.moved`, applied straight to the client cache, no refetch); a structural
// change (create/delete/status/assignee/dependency/archive) ships a tiny
// `chart.invalidated` hint so clients DEBOUNCE-refetch the fresh chart once — the whole
// chart is never pushed unsolicited. Every event is convergent + idempotent, so an actor
// re-receiving its own echo re-applies the same state (no origin-filtering needed).
export type GanttRealtimeEvent =
  | {
      kind: "row.moved";
      eventId: EventId;
      taskId: TaskId;
      startsAt: ISODateTime | null;
      endsAt: ISODateTime | null;
      at: ISODateTime;
    }
  | {
      kind: "chart.invalidated";
      eventId: EventId;
      /** The domain-event name that triggered the invalidation (e.g. "task.created").
       *  Informational only; clients treat every invalidation the same (refetch fresh). */
      reason: string;
      at: ISODateTime;
    };

/** GET /gantt/ws-ticket?eventId= response. The ticket is a short-lived HMAC token the
 *  GanttRoom DO verifies before accepting the WS; `doUrl` is the absolute DO-direct URL
 *  (gateway-bypassing) the browser opens with `?ticket=`. */
export interface GanttWsTicketResponse {
  ticket: string;
  doUrl: string;
  expiresAt: ISODateTime;
}
