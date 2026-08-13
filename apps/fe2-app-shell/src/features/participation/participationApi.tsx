// 参加届 feature api adapter. Rides the ONE shell api-client (session cookie,
// 401→refresh, requestId, error normalization). Paths are /api/v1/members/* and
// resolve at the gateway to services/member-service (participation lives there,
// next to 運営メンバー管理, so submitting can reflect onto the roster in one hop).
import type { ApiClient } from "../../lib/api-client.tsx";
import type {
  ListParticipationsResponse,
  MemberTeam,
  SubmitParticipationRequest,
  SubmitParticipationResponse,
} from "./contracts.ts";

export interface ParticipationApi {
  /** Canonical team list, to populate the 希望チーム select (identity:read). */
  listTeams(): Promise<{ teams: MemberTeam[] }>;
  /** Submit a 参加届; self-registers/promotes the person on the roster. */
  submit(input: SubmitParticipationRequest): Promise<SubmitParticipationResponse>;
  /** Admin list of submissions (identity:read). */
  list(): Promise<ListParticipationsResponse>;
}

const BASE = "/api/v1/members";

export function createParticipationApi(api: ApiClient): ParticipationApi {
  return {
    listTeams: () => api.request<{ teams: MemberTeam[] }>({ method: "GET", path: `${BASE}/teams` }),
    submit: (input) =>
      api.request<SubmitParticipationResponse, SubmitParticipationRequest>({
        method: "POST",
        path: `${BASE}/participation`,
        body: input,
      }),
    list: () => api.request<ListParticipationsResponse>({ method: "GET", path: `${BASE}/participation` }),
  };
}
