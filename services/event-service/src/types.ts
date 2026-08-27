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

// ---- event details ("何でも貯める" free-form per-event store; service-local) ----
// A single flexible document per event, stored as one row (event_id PK) holding a
// JSON `data` blob + an optimistic `version`. New fields need NO migration — they
// just extend EventDetailsData. Kept OUT of the frozen @dub/types event contract on
// purpose (additive, service-owned), mirroring how actions define their own
// request/response shapes above.
export interface EventDetailLink {
  label: string;
  url: string;
}
export interface EventDetailContact {
  label: string;
  value: string;
}
/** タイムテーブル項目 — one row of the day-of schedule. */
export interface EventScheduleItem {
  time: string;
  title: string;
  note: string;
}
/** 登壇者・ゲスト — a speaker / guest entry. */
export interface EventSpeaker {
  name: string;
  role: string;
  topic: string;
}
/** 協賛・スポンサー — a sponsor entry with tier + negotiation status. */
export interface EventSponsor {
  name: string;
  tier: string;
  status: string;
}
/** 準備チェックリスト項目 — a prep task with a done flag. */
export interface EventChecklistItem {
  label: string;
  done: boolean;
}
export interface EventDetailsData {
  /** 概要 — a short summary shown at the top of the event app. */
  overview: string;
  /** 会場 — venue / location free text. */
  venue: string;
  /** アクセス — 交通・最寄り駅・駐車場など. */
  access: string;
  /** 定員・参加予定人数 — capacity / expected headcount free text. */
  capacity: string;
  /** 持ち物・服装 — what staff/attendees should bring / dress code. */
  belongings: string;
  /** 予算・収支メモ — budget / cost notes. */
  budget: string;
  /** 当日運営フロー — day-of operations flow / responsibilities. */
  operations: string;
  /** メモ — free-form running notes (markdown-ish plain text). */
  memo: string;
  /** タイムテーブル — ordered day-of schedule. */
  schedule: EventScheduleItem[];
  /** 登壇者・ゲスト — speakers / guests. */
  speakers: EventSpeaker[];
  /** 協賛・スポンサー — sponsors. */
  sponsors: EventSponsor[];
  /** 準備チェックリスト — prep checklist. */
  checklist: EventChecklistItem[];
  /** 重要リンク — labelled URLs (agenda, drive folder, form, …). */
  links: EventDetailLink[];
  /** 連絡先 — labelled contacts (person, channel, phone, …). */
  contacts: EventDetailContact[];
}

// Internal row (superset: carries updatedBy, absent from the response).
export interface EventDetailsRow {
  eventId: common.EventId;
  data: EventDetailsData;
  version: number;
  updatedBy: common.UserId;
  updatedAt: common.ISODateTime;
}

// Wire response. version 0 + updatedAt null => never saved yet (defaults returned).
export interface EventDetailsResponse {
  eventId: common.EventId;
  data: EventDetailsData;
  version: number;
  updatedAt: common.ISODateTime | null;
}

export interface SaveEventDetailsRequest {
  data: Partial<EventDetailsData>;
  version: number;
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

  // Free-form per-event detail store. null => no row yet (caller returns defaults).
  getEventDetails(eventId: common.EventId): Promise<EventDetailsRow | null>;
  // Optimistic upsert: expectedVersion 0 inserts (fails if a row already exists),
  // >0 updates WHERE version=expectedVersion. Returns false on conflict/mismatch.
  upsertEventDetails(next: EventDetailsRow, expectedVersion: number): Promise<boolean>;
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
