// EventApi — the typed surface FE3 calls (gateway -> event-service). All shapes
// come from @dub/types event/common/identity; FE3 never redefines them. Two
// implementations: createHttpEventApi (real, over the FE2 @dub/api-client request
// surface) and createMockEventApi (Phase0 contract stub, see mockData.ts). Both satisfy
// this interface, so screens/tests are agnostic.
import type { common, event, identity } from "@dub/types";
import type { ApiClient } from "../contracts/fe2";
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

// Query values are string|number|boolean|undefined on the wire (FE2 RequestInput).
type Query = Record<string, string | number | boolean | undefined>;

/**
 * Real implementation over the FE2 @dub/api-client `request` surface. The client
 * owns the /api/v1 prefix, session/refresh/retry, and DubError normalization; FE3
 * only maps the Event > Action resource paths onto it.
 */
export function createHttpEventApi(client: ApiClient): EventApi {
  return {
    listEvents: (query) =>
      client.request<event.ListEventsResponse>({ method: "GET", path: "/api/v1/events", query: query as Query }),
    createEvent: (req) =>
      client.request<event.DubEvent, event.CreateEventRequest>({ method: "POST", path: "/api/v1/events", body: req }),
    getEvent: (id) =>
      client.request<event.GetEventResponse>({
        method: "GET",
        path: `/api/v1/events/${id}`,
        query: { include: "actions" },
      }),
    updateEvent: (id, req) =>
      client.request<event.DubEvent, event.UpdateEventRequest>({
        method: "PATCH",
        path: `/api/v1/events/${id}`,
        body: req,
      }),
    archiveEvent: (id) => client.request<void>({ method: "DELETE", path: `/api/v1/events/${id}` }),
    listActions: (eventId, query) =>
      client.request<ListActionsResponse>({
        method: "GET",
        path: `/api/v1/events/${eventId}/actions`,
        query: query as Query,
      }),
    createAction: (eventId, req) =>
      client.request<event.DubAction, CreateActionRequest>({
        method: "POST",
        path: `/api/v1/events/${eventId}/actions`,
        body: req,
      }),
    getAction: (id) => client.request<event.DubAction>({ method: "GET", path: `/api/v1/actions/${id}` }),
    updateAction: (id, req) =>
      client.request<event.DubAction, UpdateActionRequest>({
        method: "PATCH",
        path: `/api/v1/actions/${id}`,
        body: req,
      }),
    archiveAction: (id) => client.request<void>({ method: "DELETE", path: `/api/v1/actions/${id}` }),
    getUsers: (ids) =>
      client.request<common.Paginated<identity.UserSummary>>({
        method: "GET",
        path: "/api/v1/identity/users",
        query: { ids: ids.join(",") },
      }),
  };
}
