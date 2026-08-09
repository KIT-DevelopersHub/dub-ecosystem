// Business logic for events & actions. Pure of HTTP: takes parsed inputs + a
// request context, throws DubError, returns frozen wire DTOs. The Hono app is a
// thin adapter over this.
import { DubError, CommonErrorCodes, errors } from "@dub/errors";
import type { common, event, auditLog } from "@dub/types";
import type {
  AppDeps,
  EventRow,
  ActionRow,
  CreateActionRequest,
  UpdateActionRequest,
  ListActionsResponse,
  ListParticipantsResponse,
  Keyset,
} from "./types";
import {
  isValidPhaseTransition,
  phaseTransitionNeedsAdmin,
  toDubEvent,
  toDubAction,
  toEventSummary,
  toEventDetail,
  encodeCursor,
  decodeCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  INCLUDE_ACTIONS_CAP,
  SORT_ORDER_GAP,
} from "./domain";

export interface ReqCtx {
  requestId: string;
  userId: common.UserId;
}

// ---- error factories (service-specific codes; SCREAMING_SNAKE, D7) ----
const errInvalidPhase = (from: event.EventPhase, to: event.EventPhase): DubError =>
  new DubError("EVENT_INVALID_PHASE_TRANSITION", `Invalid phase transition ${from} -> ${to}`, {
    status: 400,
    details: { from, to },
  });
const errArchivedImmutable = (id: string): DubError =>
  new DubError("EVENT_ARCHIVED_IMMUTABLE", `Resource is archived and immutable: ${id}`, { status: 409 });
const errVersionConflict = (id: string): DubError =>
  new DubError("EVENT_VERSION_CONFLICT", `Version conflict for ${id}`, { status: 409 });

function requireLimit(raw?: number): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_LIMIT) {
    throw errors.validationFailed([{ field: "limit", reason: raw > MAX_LIMIT ? "too_large" : "invalid" }]);
  }
  return raw;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw errors.validationFailed([{ field, reason: "required" }]);
  }
  return value;
}

export class EventService {
  constructor(private readonly deps: AppDeps) {}

  private async auditWrite(
    ctx: ReqCtx,
    action: string,
    resourceType: string,
    resourceId: string,
    details: Record<string, unknown> | null,
    result: auditLog.AuditResult = "success",
  ): Promise<void> {
    await this.deps.audit.record({
      action,
      actorId: ctx.userId,
      orgId: this.deps.orgId,
      result,
      resourceType,
      resourceId,
      details,
      requestId: ctx.requestId,
      occurredAt: this.deps.now(),
    });
  }

  // ---- events ----
  async createEvent(ctx: ReqCtx, body: event.CreateEventRequest): Promise<event.DubEvent> {
    const title = nonEmptyString(body.title, "title");
    const now = this.deps.now();
    const row: EventRow = {
      id: this.deps.newEventId(),
      orgId: this.deps.orgId,
      title,
      description: body.description ?? null,
      phase: "planning",
      startsAt: body.startsAt ?? null,
      endsAt: body.endsAt ?? null,
      archivedAt: null,
      version: 1,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.createEvent(row);
    await this.deps.publisher.publish(
      "event.created",
      { eventId: row.id, title: row.title, phase: row.phase },
      { requestId: ctx.requestId, actorId: ctx.userId },
    );
    await this.auditWrite(ctx, "event.event.created", "event", row.id, { title: row.title });
    return toDubEvent(row);
  }

  /** Load an event scoped to the caller's org; 404 (existence-hiding) otherwise. */
  private async loadEvent(id: common.EventId): Promise<EventRow> {
    const row = await this.deps.repo.getEvent(id);
    if (!row || row.orgId !== this.deps.orgId) throw errors.notFound("event", id);
    return row;
  }

  private async loadAction(id: common.ActionId): Promise<{ action: ActionRow; event: EventRow }> {
    const action = await this.deps.repo.getAction(id);
    if (!action) throw errors.notFound("action", id);
    const ev = await this.deps.repo.getEvent(action.eventId);
    if (!ev || ev.orgId !== this.deps.orgId) throw errors.notFound("action", id);
    return { action, event: ev };
  }

  async getEvent(_ctx: ReqCtx, id: common.EventId): Promise<event.EventDetail> {
    const ev = await this.loadEvent(id);
    const actions = await this.deps.repo.actionsForEvent(id, INCLUDE_ACTIONS_CAP);
    return toEventDetail(ev, actions);
  }

  async listEvents(_ctx: ReqCtx, q: event.ListEventsQuery): Promise<event.ListEventsResponse> {
    const limit = requireLimit(q.limit);
    const after = q.cursor ? decodeCursor(q.cursor) ?? undefinedCursor(q.cursor) : undefined;
    const rows = await this.deps.repo.listEvents({
      orgId: this.deps.orgId,
      ...(q.phase ? { phase: q.phase } : {}),
      ...(q.startsAfter ? { startsAfter: q.startsAfter } : {}),
      ...(q.sort ? { sort: q.sort } : {}),
      includeArchived: q.includeArchived ?? false,
      limit: limit + 1, // fetch one extra to detect next page
      ...(after ? { after } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(cursorFor(last, q.sort)) : null;
    return { items: page.map(toEventSummary), nextCursor };
  }

  async updateEvent(
    ctx: ReqCtx,
    id: common.EventId,
    body: event.UpdateEventRequest,
  ): Promise<event.DubEvent> {
    if (typeof body.version !== "number") {
      throw errors.validationFailed([{ field: "version", reason: "required" }]);
    }
    const ev = await this.loadEvent(id);
    if (ev.archivedAt) throw errArchivedImmutable(id);
    if (ev.version !== body.version) throw errVersionConflict(id);

    const changed: string[] = [];
    const next: EventRow = { ...ev };

    let phaseChange: { from: event.EventPhase; to: event.EventPhase } | null = null;
    if (body.phase !== undefined && body.phase !== ev.phase) {
      const from = ev.phase;
      const to = body.phase;
      if (!isValidPhaseTransition(from, to)) throw errInvalidPhase(from, to);
      if (phaseTransitionNeedsAdmin(from, to)) {
        const ok = await this.deps.authz.hasPermission(ctx.userId, this.deps.orgId, {
          permission: "event:admin",
          resourceType: "event",
          resourceId: id,
        });
        if (!ok) throw new DubError(CommonErrorCodes.FORBIDDEN, "permission denied: event:admin", { status: 403 });
      }
      next.phase = to;
      phaseChange = { from, to };
    }
    if (body.title !== undefined) {
      next.title = nonEmptyString(body.title, "title");
      changed.push("title");
    }
    if (body.description !== undefined) {
      next.description = body.description;
      changed.push("description");
    }
    if (body.startsAt !== undefined) {
      next.startsAt = body.startsAt;
      changed.push("startsAt");
    }
    if (body.endsAt !== undefined) {
      next.endsAt = body.endsAt;
      changed.push("endsAt");
    }

    next.version = ev.version + 1;
    next.updatedAt = this.deps.now();
    const ok = await this.deps.repo.updateEvent(next, body.version);
    if (!ok) throw errVersionConflict(id);

    const actorCtx = { requestId: ctx.requestId, actorId: ctx.userId };
    if (phaseChange) {
      await this.deps.publisher.publish(
        "event.phase_changed",
        { eventId: id, previousPhase: phaseChange.from, phase: phaseChange.to },
        actorCtx,
      );
      await this.auditWrite(ctx, "event.event.phase_changed", "event", id, phaseChange);
    }
    if (changed.length > 0) {
      await this.deps.publisher.publish("event.updated", { eventId: id, changed }, actorCtx);
      await this.auditWrite(ctx, "event.event.updated", "event", id, { changed });
    }
    return toDubEvent(next);
  }

  async archiveEvent(ctx: ReqCtx, id: common.EventId): Promise<void> {
    const ev = await this.loadEvent(id);
    if (ev.archivedAt) return; // idempotent
    const next: EventRow = { ...ev, archivedAt: this.deps.now(), version: ev.version + 1, updatedAt: this.deps.now() };
    const ok = await this.deps.repo.updateEvent(next, ev.version);
    if (!ok) throw errVersionConflict(id);
    await this.deps.publisher.publish("event.archived", { eventId: id }, { requestId: ctx.requestId, actorId: ctx.userId });
    await this.auditWrite(ctx, "event.event.archived", "event", id, null);
  }

  async listParticipants(ctx: ReqCtx, id: common.EventId): Promise<ListParticipantsResponse> {
    const ev = await this.loadEvent(id);
    const actions = await this.deps.repo.actionsForEvent(id, INCLUDE_ACTIONS_CAP);
    const taskAssignees = await this.deps.taskClient.listAssigneeIds(
      { requestId: ctx.requestId, userId: ctx.userId },
      id,
    );
    const set = new Set<common.UserId>();
    set.add(ev.createdBy);
    for (const a of actions) set.add(a.createdBy);
    for (const u of taskAssignees) set.add(u);
    return { userIds: [...set] };
  }

  // ---- actions (hierarchy: only created under an existing, non-archived event) ----
  async createAction(ctx: ReqCtx, eventId: common.EventId, body: CreateActionRequest): Promise<event.DubAction> {
    const ev = await this.loadEvent(eventId); // 404 if event missing / cross-org
    if (ev.archivedAt) throw errArchivedImmutable(eventId);
    const kind = nonEmptyString(body.kind, "kind");
    const title = nonEmptyString(body.title, "title");
    const sortOrder =
      body.sortOrder ?? (await this.deps.repo.maxSortOrder(eventId)) + SORT_ORDER_GAP;
    const now = this.deps.now();
    const row: ActionRow = {
      id: this.deps.newActionId(),
      eventId,
      kind,
      title,
      sortOrder,
      archivedAt: null,
      version: 1,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.createAction(row);
    await this.deps.publisher.publish(
      "action.created",
      { actionId: row.id, eventId, kind: row.kind },
      { requestId: ctx.requestId, actorId: ctx.userId },
    );
    await this.auditWrite(ctx, "event.action.created", "action", row.id, { eventId, kind: row.kind });
    return toDubAction(row);
  }

  async getAction(_ctx: ReqCtx, id: common.ActionId): Promise<event.DubAction> {
    const { action } = await this.loadAction(id);
    return toDubAction(action);
  }

  async listActions(
    _ctx: ReqCtx,
    eventId: common.EventId,
    q: { cursor?: string; limit?: number; kind?: string; includeArchived?: boolean },
  ): Promise<ListActionsResponse> {
    await this.loadEvent(eventId); // 404 if missing / cross-org
    const limit = requireLimit(q.limit);
    const after = q.cursor ? decodeCursor(q.cursor) ?? undefinedCursor(q.cursor) : undefined;
    const rows = await this.deps.repo.listActions({
      eventId,
      ...(q.kind ? { kind: q.kind } : {}),
      includeArchived: q.includeArchived ?? false,
      limit: limit + 1,
      ...(after ? { after } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ n: last.sortOrder, id: last.id }) : null;
    return { items: page.map(toDubAction), nextCursor };
  }

  async updateAction(ctx: ReqCtx, id: common.ActionId, body: UpdateActionRequest): Promise<event.DubAction> {
    if (typeof body.version !== "number") {
      throw errors.validationFailed([{ field: "version", reason: "required" }]);
    }
    const { action, event: ev } = await this.loadAction(id);
    if (ev.archivedAt || action.archivedAt) throw errArchivedImmutable(id);
    if (action.version !== body.version) throw errVersionConflict(id);

    const changed: string[] = [];
    const next: ActionRow = { ...action };
    if (body.kind !== undefined) {
      next.kind = nonEmptyString(body.kind, "kind");
      changed.push("kind");
    }
    if (body.title !== undefined) {
      next.title = nonEmptyString(body.title, "title");
      changed.push("title");
    }
    if (body.sortOrder !== undefined) {
      if (!Number.isFinite(body.sortOrder)) throw errors.validationFailed([{ field: "sortOrder", reason: "invalid" }]);
      next.sortOrder = body.sortOrder;
      changed.push("sortOrder");
    }
    next.version = action.version + 1;
    next.updatedAt = this.deps.now();
    const ok = await this.deps.repo.updateAction(next, body.version);
    if (!ok) throw errVersionConflict(id);

    if (changed.length > 0) {
      await this.deps.publisher.publish(
        "action.updated",
        { actionId: id, eventId: next.eventId, changed },
        { requestId: ctx.requestId, actorId: ctx.userId },
      );
      await this.auditWrite(ctx, "event.action.updated", "action", id, { changed });
    }
    return toDubAction(next);
  }

  async archiveAction(ctx: ReqCtx, id: common.ActionId): Promise<void> {
    const { action } = await this.loadAction(id);
    if (action.archivedAt) return; // idempotent
    const next: ActionRow = { ...action, archivedAt: this.deps.now(), version: action.version + 1, updatedAt: this.deps.now() };
    const ok = await this.deps.repo.updateAction(next, action.version);
    if (!ok) throw errVersionConflict(id);
    await this.deps.publisher.publish(
      "action.archived",
      { actionId: id, eventId: action.eventId },
      { requestId: ctx.requestId, actorId: ctx.userId },
    );
    await this.auditWrite(ctx, "event.action.archived", "action", id, { eventId: action.eventId });
  }
}

function cursorFor(row: EventRow, sort?: "startsAt"): Keyset {
  return sort === "startsAt" ? { s: row.startsAt, id: row.id } : { id: row.id };
}

// A malformed cursor is a client error (400), not silent full-scan.
function undefinedCursor(raw: string): never {
  throw errors.validationFailed([{ field: "cursor", reason: "invalid", message: `unparseable cursor: ${raw.slice(0, 16)}` }]);
}
