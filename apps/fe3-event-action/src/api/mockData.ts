// In-memory Phase0 contract stub for EventApi. Enforces the same invariants the
// real event-service will (optimistic version lock -> EVENT_VERSION_CONFLICT,
// phase table -> EVENT_INVALID_PHASE_TRANSITION, archive immutability ->
// EVENT_ARCHIVED_IMMUTABLE), so screens and tests exercise the real contract.
// Errors are thrown as DubError (code+status), which toDisplayableError handles.
import { DubError, CommonErrorCodes } from "@dub/errors";
import { event as ev } from "@dub/types";
import type { common, event, identity } from "@dub/types";
import type { EventApi } from "./eventApi";
import type {
  CreateActionRequest,
  ListActionsQuery,
  ListActionsResponse,
  UpdateActionRequest,
} from "./actionContracts";
import { EventErrorCodes } from "../lib/errorMap";
import { nextSortOrder } from "../lib/sortOrder";

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36).padStart(6, "0")}`;
}
function now(): string {
  return new Date().toISOString();
}

interface Store {
  events: Map<string, event.DubEvent>;
  actions: Map<string, event.DubAction>;
  users: Map<string, identity.UserSummary>;
}

function encodeCursor(index: number): string {
  return btoa(String(index));
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(atob(cursor));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return 50;
  return Math.min(limit, 200);
}

function toSummary(e: event.DubEvent): event.EventSummary {
  return { id: e.id, title: e.title, phase: e.phase, startsAt: e.startsAt };
}
function toActionSummary(a: event.DubAction): event.ActionSummary {
  return { id: a.id, eventId: a.eventId, kind: a.kind, title: a.title };
}

export interface MockSeed {
  orgId?: common.OrgId;
  events?: number;
  actionsPerEvent?: number;
}

export function createStore(seed: MockSeed = {}): Store {
  const orgId = seed.orgId ?? "org_devhub";
  const store: Store = { events: new Map(), actions: new Map(), users: new Map() };

  const u1: identity.UserSummary = { id: id("usr"), displayName: "織田信長", avatarUrl: null };
  const u2: identity.UserSummary = { id: id("usr"), displayName: "豊臣秀吉", avatarUrl: null };
  store.users.set(u1.id, u1);
  store.users.set(u2.id, u2);

  const evCount = seed.events ?? 2;
  const phases: event.EventPhase[] = ["planning", "open", "live", "wrapup", "closed"];
  for (let i = 0; i < evCount; i++) {
    const eid = id("evt");
    const e: event.DubEvent = {
      id: eid,
      orgId,
      title: `北陸ITカンファレンス ${2026 + i}`,
      description: i === 0 ? "年次カンファレンス" : null,
      phase: phases[i % phases.length]!,
      startsAt: now(),
      endsAt: null,
      archivedAt: null,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    store.events.set(eid, e);
    const perEvent = seed.actionsPerEvent ?? 3;
    for (let j = 0; j < perEvent; j++) {
      const aid = id("act");
      const kinds = ["task_management", "announcement", "custom_survey"];
      const a: event.DubAction = {
        id: aid,
        eventId: eid,
        kind: kinds[j % kinds.length]!,
        title: `アクション ${j + 1}`,
        sortOrder: (j + 1) * 1024,
        archivedAt: null,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      store.actions.set(aid, a);
    }
  }
  return store;
}

export function createMockEventApi(seed: MockSeed = {}, latencyMs = 0): EventApi {
  const store = createStore(seed);
  const orgId = seed.orgId ?? "org_devhub";
  const delay = () => (latencyMs > 0 ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());

  function getEventOr404(eid: string): event.DubEvent {
    const e = store.events.get(eid);
    if (!e) throw new DubError(CommonErrorCodes.NOT_FOUND, `Event not found: ${eid}`, { status: 404 });
    return e;
  }
  function getActionOr404(aid: string): event.DubAction {
    const a = store.actions.get(aid);
    if (!a) throw new DubError(CommonErrorCodes.NOT_FOUND, `Action not found: ${aid}`, { status: 404 });
    return a;
  }
  function assertVersion(current: number, incoming: number, code: string): void {
    if (current !== incoming) {
      throw new DubError(code, "Version conflict; refetch and retry", { status: 409 });
    }
  }

  return {
    async listEvents(query: event.ListEventsQuery): Promise<event.ListEventsResponse> {
      await delay();
      let items = [...store.events.values()];
      if (!query.includeArchived) items = items.filter((e) => e.archivedAt === null);
      if (query.phase) items = items.filter((e) => e.phase === query.phase);
      items.sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
      const start = decodeCursor(query.cursor);
      const limit = clampLimit(query.limit);
      const page = items.slice(start, start + limit);
      const end = start + limit;
      return {
        items: page.map(toSummary),
        nextCursor: end < items.length ? encodeCursor(end) : null,
      };
    },

    async createEvent(req: event.CreateEventRequest): Promise<event.DubEvent> {
      await delay();
      if (!req.title || req.title.trim() === "") {
        throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "Validation failed", {
          status: 400,
          details: [{ field: "title", reason: "required", message: "タイトルは必須です" }],
        });
      }
      const eid = id("evt");
      const e: event.DubEvent = {
        id: eid,
        orgId,
        title: req.title,
        description: req.description ?? null,
        phase: "planning",
        startsAt: req.startsAt ?? null,
        endsAt: req.endsAt ?? null,
        archivedAt: null,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      store.events.set(eid, e);
      return e;
    },

    async getEvent(eid: common.EventId): Promise<event.GetEventResponse> {
      await delay();
      const e = getEventOr404(eid);
      const actions = [...store.actions.values()]
        .filter((a) => a.eventId === eid && a.archivedAt === null)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(toActionSummary);
      return { ...e, actions };
    },

    async updateEvent(eid: common.EventId, req: event.UpdateEventRequest): Promise<event.DubEvent> {
      await delay();
      const e = getEventOr404(eid);
      if (e.archivedAt !== null) {
        throw new DubError(EventErrorCodes.ARCHIVED_IMMUTABLE, "Event is archived (read-only)", { status: 409 });
      }
      assertVersion(e.version, req.version, EventErrorCodes.VERSION_CONFLICT);
      if (req.phase && req.phase !== e.phase) {
        const allowed = ev.EVENT_PHASE_TRANSITIONS[e.phase];
        if (!allowed.includes(req.phase)) {
          throw new DubError(EventErrorCodes.INVALID_PHASE_TRANSITION, `Invalid phase: ${e.phase} -> ${req.phase}`, {
            status: 400,
          });
        }
      }
      const updated: event.DubEvent = {
        ...e,
        title: req.title ?? e.title,
        description: req.description !== undefined ? req.description : e.description,
        phase: req.phase ?? e.phase,
        startsAt: req.startsAt !== undefined ? req.startsAt : e.startsAt,
        endsAt: req.endsAt !== undefined ? req.endsAt : e.endsAt,
        version: e.version + 1,
        updatedAt: now(),
      };
      store.events.set(eid, updated);
      return updated;
    },

    async archiveEvent(eid: common.EventId): Promise<void> {
      await delay();
      const e = getEventOr404(eid);
      store.events.set(eid, { ...e, archivedAt: now(), updatedAt: now(), version: e.version + 1 });
    },

    async listActions(eid: common.EventId, query?: ListActionsQuery): Promise<ListActionsResponse> {
      await delay();
      getEventOr404(eid);
      let items = [...store.actions.values()].filter((a) => a.eventId === eid && a.archivedAt === null);
      if (query?.kind) items = items.filter((a) => a.kind === query.kind);
      items.sort((a, b) => a.sortOrder - b.sortOrder);
      const start = decodeCursor(query?.cursor);
      const limit = clampLimit(query?.limit);
      const page = items.slice(start, start + limit);
      const end = start + limit;
      return { items: page, nextCursor: end < items.length ? encodeCursor(end) : null };
    },

    async createAction(eid: common.EventId, req: CreateActionRequest): Promise<event.DubAction> {
      await delay();
      const e = getEventOr404(eid);
      if (e.archivedAt !== null) {
        throw new DubError(EventErrorCodes.ARCHIVED_IMMUTABLE, "Event is archived (read-only)", { status: 409 });
      }
      if (!req.title || req.title.trim() === "") {
        throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "Validation failed", {
          status: 400,
          details: [{ field: "title", reason: "required", message: "タイトルは必須です" }],
        });
      }
      const existing = [...store.actions.values()].filter((a) => a.eventId === eid && a.archivedAt === null);
      const aid = id("act");
      const a: event.DubAction = {
        id: aid,
        eventId: eid,
        kind: req.kind,
        title: req.title,
        sortOrder: req.sortOrder ?? nextSortOrder(existing),
        archivedAt: null,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      store.actions.set(aid, a);
      return a;
    },

    async getAction(aid: common.ActionId): Promise<event.DubAction> {
      await delay();
      return getActionOr404(aid);
    },

    async updateAction(aid: common.ActionId, req: UpdateActionRequest): Promise<event.DubAction> {
      await delay();
      const a = getActionOr404(aid);
      assertVersion(a.version, req.version, EventErrorCodes.VERSION_CONFLICT);
      const updated: event.DubAction = {
        ...a,
        title: req.title ?? a.title,
        kind: req.kind ?? a.kind,
        sortOrder: req.sortOrder ?? a.sortOrder,
        version: a.version + 1,
        updatedAt: now(),
      };
      store.actions.set(aid, updated);
      return updated;
    },

    async archiveAction(aid: common.ActionId): Promise<void> {
      await delay();
      const a = getActionOr404(aid);
      store.actions.set(aid, { ...a, archivedAt: now(), updatedAt: now(), version: a.version + 1 });
    },

    async getUsers(ids: readonly common.UserId[]): Promise<common.Paginated<identity.UserSummary>> {
      await delay();
      if (ids.length > 50) {
        throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "Too many ids (max 50)", { status: 400 });
      }
      const items = ids.map((uid) => store.users.get(uid)).filter((u): u is identity.UserSummary => u !== undefined);
      return { items, nextCursor: null };
    },
  };
}
