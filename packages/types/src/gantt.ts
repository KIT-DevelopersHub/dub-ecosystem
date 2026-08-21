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

// ── Realtime collaboration: presence + live data sync ────────────────────────
// gantt-service owns a Durable Object ("GanttRoom"), one instance per eventId, that
// fans out two kinds of frames over a gateway-bypassing / DO-direct WebSocket:
//   1. presence — who is currently viewing/editing this gantt (Google-Docs-style avatars)
//   2. data.changed — a peer committed a write, so refetch the authoritative rows.
// The DB stays the SINGLE source of truth (last-write-wins): WS carries only signals;
// the confirmed values always come from the REST API. This mirrors the chat-service
// RT土台 (theme11): HMAC ws-ticket + Origin verified at the DO, no header trust on /ws.

/** TTLs / cadences shared by the DO and the client (SoT so both sides agree). */
export const GANTT_WS_TICKET_TTL_SEC = 60;
/** Client heartbeat interval — keeps the socket's presence entry fresh. */
export const GANTT_PRESENCE_HEARTBEAT_MS = 15_000;
/** A socket with no heartbeat for this long is reaped by the DO's alarm (half-open
 *  / crashed tab cleanup) so a stale avatar disappears even without a clean close. */
export const GANTT_PRESENCE_TTL_MS = 45_000;

/** The kind of gantt mutation a `data.changed` frame announces, so a receiver can
 *  label/log it. Open by intent: clients MUST tolerate an unknown kind (⇒ "refetch"). */
export type GanttChangeKind =
  | "task.upserted"
  | "task.deleted"
  | "schedule"
  | "relations"
  | "reorder"
  | "view";

/** One participant connected to a gantt room, deduped by userId across that user's
 *  tabs. `editing` is true when ANY of the user's sockets is mid-edit (detail panel
 *  open / dragging a bar); `editingTaskIds` is the union of the rows they're touching. */
export interface GanttPresenceUser {
  userId: UserId;
  /** Label the DO learned from the SIGNED ws-ticket (non-spoofable). Absent when the
   *  issuer could not resolve a name — the client then falls back to its own roster. */
  displayName?: string;
  editing: boolean;
  editingTaskIds: TaskId[];
}

/** Server → client WS frames fanned out by the GanttRoom DO. */
export type GanttRealtimeEvent =
  | { kind: "presence"; users: GanttPresenceUser[] }
  | {
      kind: "data.changed";
      /** GanttChangeKind, but widened so an older client never rejects a newer kind. */
      change: GanttChangeKind | string;
      taskId?: TaskId | null;
      actorId: UserId;
      at: ISODateTime;
    };

/** Client → server WS frames. The DO trusts ONLY the socket's ticket-derived identity —
 *  never any userId a frame might carry — so these frames cannot spoof another user. */
export type GanttClientMessage =
  | { t: "hello" } // request the current presence snapshot
  | { t: "ping" } // heartbeat (keeps the presence entry alive)
  | { t: "state"; editing: boolean; editingTaskId?: TaskId | null } // viewing⇄editing
  | { t: "change"; change: GanttChangeKind | string; taskId?: TaskId | null }; // "I saved"

/** GET /gantt/ws-ticket response — a short-lived HMAC ticket + the absolute DO URL to
 *  connect to (DO-direct, gateway bypassed), plus the caller's own identity so the
 *  client can mark "you" in the presence bar without a second /me round-trip. */
export interface WsTicketResponse {
  ticket: string; // short-lived; verified by the GanttRoom DO
  doUrl: string; // absolute wss:// URL of the DO (gateway bypassed)
  expiresAt: ISODateTime;
  self: { userId: UserId; displayName?: string };
}
