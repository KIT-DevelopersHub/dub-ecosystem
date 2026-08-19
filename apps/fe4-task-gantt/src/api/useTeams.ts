import { useQuery } from "@tanstack/react-query";
import type { team } from "@dub/types";
import { useApiClient } from "./client-context";
import { listTeams, toDomainTeams } from "./endpoints";

/**
 * Single source for the team list. Today it reads the mock `/api/v1/teams`;
 * when member-service ships its team API, only `listTeams` needs to be re-pointed
 * — every consumer (view switch, create/detail team select) keeps working.
 */
export function useTeams() {
  const client = useApiClient();
  return useQuery({
    queryKey: ["teams", "list"] as const,
    queryFn: async (): Promise<team.Team[]> => toDomainTeams(await listTeams(client)),
    staleTime: 5 * 60_000,
  });
}
