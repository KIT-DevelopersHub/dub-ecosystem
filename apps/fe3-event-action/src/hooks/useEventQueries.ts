// TanStack Query read hooks. All keys start with "events" (queryKeys.ts).
import { useQuery } from "@tanstack/react-query";
import type { common, event, identity } from "@dub/types";
import { useEventApi } from "../context/ApiContext";
import { eventKeys } from "../lib/queryKeys";
import type { ListActionsQuery, ListActionsResponse } from "../api/actionContracts";
import type { EventDetails } from "../api/detailsContracts";

export function useEventsQuery(query: event.ListEventsQuery) {
  const api = useEventApi();
  return useQuery<event.ListEventsResponse>({
    queryKey: eventKeys.list(query),
    queryFn: () => api.listEvents(query),
  });
}

export function useEventDetailQuery(eventId: common.EventId | null) {
  const api = useEventApi();
  return useQuery<event.GetEventResponse>({
    queryKey: eventId ? eventKeys.detail(eventId) : eventKeys.details(),
    queryFn: () => api.getEvent(eventId as common.EventId),
    enabled: eventId !== null,
  });
}

export function useEventDetailsQuery(eventId: common.EventId | null) {
  const api = useEventApi();
  return useQuery<EventDetails>({
    queryKey: eventId ? eventKeys.eventDetails(eventId) : eventKeys.details(),
    queryFn: () => api.getEventDetails(eventId as common.EventId),
    enabled: eventId !== null,
    // Settle fast on a hard failure so the panel degrades to its empty state
    // instead of holding the skeleton across long default back-off (⑤).
    retry: 1,
  });
}

export function useActionsQuery(eventId: common.EventId, query?: ListActionsQuery) {
  const api = useEventApi();
  return useQuery<ListActionsResponse>({
    queryKey: eventKeys.actions(eventId),
    queryFn: () => api.listActions(eventId, query),
  });
}

export function useActionQuery(actionId: common.ActionId | null) {
  const api = useEventApi();
  return useQuery<event.DubAction>({
    queryKey: actionId ? eventKeys.action(actionId) : eventKeys.all,
    queryFn: () => api.getAction(actionId as common.ActionId),
    enabled: actionId !== null,
  });
}

export function useUsersQuery(ids: readonly common.UserId[]) {
  const api = useEventApi();
  return useQuery<common.Paginated<identity.UserSummary>>({
    queryKey: eventKeys.users(ids),
    queryFn: () => api.getUsers(ids),
    enabled: ids.length > 0,
  });
}
