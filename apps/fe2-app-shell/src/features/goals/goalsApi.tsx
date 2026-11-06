// 目標管理 feature の api アダプタ。/api/v1/members/goals → gateway → member-service。契約型は @dub/types `goal`。
import type { goal } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

export interface GoalsApi {
  list(month: string): Promise<goal.ListGoalsResponse>;
  put(teamId: string, month: string, body: goal.PutGoalRequest): Promise<goal.TeamGoal>;
  remove(teamId: string, month: string): Promise<void>;
}

const BASE = "/api/v1/members/goals";
const path = (teamId: string, month: string) => `${BASE}/${encodeURIComponent(teamId)}/${month}` as const;

export function createGoalsApi(api: ApiClient): GoalsApi {
  return {
    list: (month) => api.request<goal.ListGoalsResponse>({ method: "GET", path: BASE, query: { month } }),
    put: (teamId, month, body) => api.request<goal.TeamGoal, goal.PutGoalRequest>({ method: "PUT", path: path(teamId, month), body }),
    remove: async (teamId, month) => {
      await api.request<void>({ method: "DELETE", path: path(teamId, month) });
    },
  };
}
