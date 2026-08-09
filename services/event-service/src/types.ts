// Service-local types. Wire entity/DTO types come frozen from @dub/types (event
// namespace); we define ONLY what the frozen package does not carry:
//   - internal row models (carry created_by, absent from the wire types)
//   - action request/response shapes (frozen event.ts defines DubAction but no
//     action request contracts) + participants response.
import type { common, event, auditLog } from "@dub/types";
import type { MiddlewareHandler, Context } from "hono";
import type { DubEventName, DubEventPayloadMap } from "@dub/events";

// ---- internal persistence rows (superset of wire types; created_by is internal) ----
export interface EventRow {
  id: common.EventId;
  orgId: common.OrgId;
  title: string;
  description: string | null;
  phase: event.EventPhase;
  startsAt: common.ISODateTime | null;
  endsAt: common.ISODateTime | null;
  archivedAt: common.ISODateTime | null;
  version: number;
  createdBy: common.UserId;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

export interface ActionRow {
  id: common.ActionId;
  eventId: common.EventId;
  kind: string;
  title: string;
  sortOrder: number;
  archivedAt: common.ISODateTime | null;
  version: number;
  createdBy: common.UserId;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

// ---- action request/response contracts (service-local; not in frozen @dub/types) ----
export interface CreateActionRequest {
  kind: string;
  title: string;
  sortOrder?: number;
}
export interface UpdateActionRequest extends common.Versioned {
  kind?: string;
  title?: string;
  sortOrder?: number;
}
export interface ListActionsQuery extends common.CursorQuery {
  kind?: string;
  includeArchived?: boolean;
}
export type ListActionsResponse = common.Paginated<event.DubAction>;

export interface ListParticipantsResponse {
  userIds: common.UserId[];
}

// ---- pagination keyset ----
export interface Keyset {
  // For events sort=startsAt, `s` is the last starts_at (null sorts last).
  // For actions (ordered by sort_order), `n` is the last sort_order. `id` breaks ties.
  s?: string | null;
  n?: number;
  id: string;
}

// ---- injected dependencies (enables full HTTP-level tests with fakes) ----
export interface EventPublisher {
  publish<N extends DubEventName>(
    name: N,
    payload: DubEventPayloadMap[N],
    ctx: { requestId: string; actorId: string | null },
  ): Promise<void>;
}

export interface AuditSink {
  record(input: auditLog.AuditRecordInput): Promise<void>;
}

// Subset of @dub/auth-client's AuthClient that the app consumes. The real client
// satisfies this; tests inject a fake.
export interface Authz {
  requireAuth(): MiddlewareHandler;
  requirePermission(
    permission: import("@dub/types").identity.PermissionKey,
    resolve?: (c: Context) => { orgId?: string; resourceType?: string; resourceId?: string },
  ): MiddlewareHandler;
  hasPermission(
    userId: common.UserId,
    orgId: common.OrgId,
    query: import("@dub/types").identity.AuthzQuery,
  ): Promise<boolean>;
}

export interface TaskClient {
  // Read-only participant synthesis: assignee userIds of the event's tasks.
  listAssigneeIds(ctx: { requestId: string; userId?: string }, eventId: common.EventId): Promise<common.UserId[]>;
}

export interface EventRepo {
  createEvent(row: EventRow): Promise<void>;
  getEvent(id: common.EventId): Promise<EventRow | null>;
  listEvents(q: {
    orgId: common.OrgId;
    phase?: event.EventPhase;
    startsAfter?: string;
    sort?: "startsAt";
    includeArchived: boolean;
    limit: number;
    after?: Keyset;
  }): Promise<EventRow[]>;
  // Optimistic write: UPDATE ... WHERE id=? AND version=expectedVersion. Returns
  // false when no row matched (version conflict / not found).
  updateEvent(next: EventRow, expectedVersion: number): Promise<boolean>;

  createAction(row: ActionRow): Promise<void>;
  getAction(id: common.ActionId): Promise<ActionRow | null>;
  listActions(q: {
    eventId: common.EventId;
    kind?: string;
    includeArchived: boolean;
    limit: number;
    after?: Keyset;
  }): Promise<ActionRow[]>;
  updateAction(next: ActionRow, expectedVersion: number): Promise<boolean>;
  // For EventDetail (GET /events/:id) — non-archived, ordered by sort_order, capped.
  actionsForEvent(eventId: common.EventId, cap: number): Promise<ActionRow[]>;
  maxSortOrder(eventId: common.EventId): Promise<number>;
}

export interface AppDeps {
  repo: EventRepo;
  authz: Authz;
  publisher: EventPublisher;
  audit: AuditSink;
  taskClient: TaskClient;
  orgId: common.OrgId;
  now: () => string;
  newEventId: () => common.EventId;
  newActionId: () => common.ActionId;
}
