import { useQuery } from "@tanstack/react-query";
import type { common } from "@dub/types";
import { useApiClient } from "./client-context";

const EMPTY: readonly common.TeamId[] = [];

/**
 * The teams I belong to (`myTeamIds` of GET /members/me/mention-teams — self-scoped, any
 * signed-in user). #881: members of a task's team may edit it. Failure ⇒ no team grants
 * (fail-closed; the server is the real gate). Keyed by user (代理表示 switches it).
 */
export function useMyTeamIds(userId: common.UserId | null | undefined): readonly common.TeamId[] {
  const client = useApiClient();
  const q = useQuery({
    queryKey: ["members", "me", "mention-teams", "myTeamIds", userId ?? null] as const,
    queryFn: async (): Promise<common.TeamId[]> => {
      try {
        const res = await client.request<{ myTeamIds?: string[] }>({ method: "GET", path: "/api/v1/members/me/mention-teams" });
        return res.myTeamIds ?? [];
      } catch {
        return [];
      }
    },
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });
  return q.data ?? EMPTY;
}
