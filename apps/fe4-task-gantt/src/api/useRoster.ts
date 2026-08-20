import { useQuery } from "@tanstack/react-query";
import type { identity } from "@dub/types";
import { useApiClient } from "./client-context";
import { listRosterUsers } from "./endpoints";

/**
 * The org member roster, so an assignee can be picked from real members — not
 * only from users already assigned to a task (the old behaviour left the dropdown
 * showing "未割当" alone on a fresh event). Best-effort: an organizer without
 * identity:read gets a 403; we swallow it and fall back to the resolved-from-tasks
 * list rather than break the page (retry off so a denied read isn't hammered).
 */
export function useRoster() {
  const client = useApiClient();
  return useQuery({
    queryKey: ["tasks", "roster"] as const,
    queryFn: async (): Promise<identity.UserSummary[]> => {
      try {
        return (await listRosterUsers(client)).items;
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
