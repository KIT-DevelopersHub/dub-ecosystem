// Upcoming events for the 本戦 countdown (#858). /bff/home's upcomingEvents is capped
// at 5 (oldest first), so the conference can fall outside it; this asks event-service
// for future events directly. Failure degrades to [] (the tile just hides).
import { useQuery } from "@tanstack/react-query";
import type { event } from "@dub/types";
import type { ApiClient } from "../../../lib/api-client.tsx";
import { queryKeys } from "../../../lib/queryKeys.tsx";

export function useConferenceEvents(api: ApiClient): event.EventSummary[] {
  const query = useQuery({
    queryKey: queryKeys.conferenceEvents,
    queryFn: async () => {
      const res = await api.request<event.ListEventsResponse>({
        method: "GET",
        path: "/api/v1/events",
        query: { sort: "startsAt", startsAfter: new Date().toISOString(), limit: 50 },
      });
      return res.items;
    },
    staleTime: 60 * 60 * 1000,
  });
  return query.data ?? [];
}
