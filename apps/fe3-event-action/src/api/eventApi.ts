// EventApi — the typed surface FE3 calls (gateway -> event-service). All shapes
// come from @dub/types event/common/identity; FE3 never redefines them. Two
// implementations: createHttpEventApi (real, over FE2 @dub/api-client HttpClient)
// and createMockEventApi (Phase0 contract stub, see mockData.ts). Both satisfy
// this interface, so screens/tests are agnostic.
import type { common, event, identity } from "@dub/types";
import type { HttpClient } from "../contracts/fe2";
import type {
  CreateActionRequest,
  ListActionsQuery,
  ListActionsResponse,
  UpdateActionRequest,
} from "./actionContracts";

export interface EventApi {
  listEvents(query: event.ListEventsQuery): Promise<event.ListEventsResponse>;
  createEvent(req: event.CreateEventRequest): Promise<event.DubEvent>;
  getEvent(id: common.EventId): Promise<event.GetEventResponse>; // include=actions
  updateEvent(id: common.EventId, req: event.UpdateEventRequest): Promise<event.DubEvent>;
  archiveEvent(id: common.EventId): Promise<void>;

  listActions(eventId: common.EventId, query?: ListActionsQuery): Promise<ListActionsResponse>;
  createAction(eventId: common.EventId, req: CreateActionRequest): Promise<event.DubAction>;
  getAction(id: common.ActionId): Promise<event.DubAction>;
  updateAction(id: common.ActionId, req: UpdateActionRequest): Promise<event.DubAction>;
  archiveAction(id: common.ActionId): Promise<void>;

  // assignee display-name batch resolution (theme2 B1; N+1 avoidance, max 50).
  getUsers(ids: readonly common.UserId[]): Promise<common.Paginated<identity.UserSummary>>;
}

/** Real implementation over the FE2 HttpClient (paths are logical; client adds /api/v1). */
export function createHttpEventApi(client: HttpClient): EventApi {
  return {
    listEvents: (query) => client.get<event.ListEventsResponse>("/events", query as Record<string, unknown>),
    createEvent: (req) => client.post<event.DubEvent>("/events", req),
    getEvent: (id) => client.get<event.GetEventResponse>(`/events/${id}`, { include: "actions" }),
    updateEvent: (id, req) => client.patch<event.DubEvent>(`/events/${id}`, req),
    archiveEvent: (id) => client.del<void>(`/events/${id}`),
    listActions: (eventId, query) =>
      client.get<ListActionsResponse>(`/events/${eventId}/actions`, query as Record<string, unknown>),
    createAction: (eventId, req) => client.post<event.DubAction>(`/events/${eventId}/actions`, req),
    getAction: (id) => client.get<event.DubAction>(`/actions/${id}`),
    updateAction: (id, req) => client.patch<event.DubAction>(`/actions/${id}`, req),
    archiveAction: (id) => client.del<void>(`/actions/${id}`),
    getUsers: (ids) =>
      client.get<common.Paginated<identity.UserSummary>>("/identity/users", { ids: ids.join(",") }),
  };
}
