// 参加届 feature api adapter. Rides the ONE shell api-client (session cookie,
// 401→refresh, requestId, error normalization). Paths are /api/v1/members/* and
// resolve at the gateway to services/member-service (participation lives there,
// next to 運営メンバー管理, so submitting can reflect onto the roster in one hop).
import type { ApiClient } from "../../lib/api-client.tsx";
import type {
  ListParticipationsResponse,
  MemberTeam,
  PublicParticipationResponse,
  SubmitParticipationRequest,
} from "./contracts.ts";

export interface ParticipationApi {
  /** Canonical team list, to populate the 希望チーム select (identity:read). */
  listTeams(): Promise<{ teams: MemberTeam[] }>;
  /** Submit a 参加届 via the PUBLIC (unauthenticated) endpoint. Self-registers/promotes
   *  the person on the roster server-side; the response is minimal (accepted + matchKind,
   *  no member echo) so nothing about the roster leaks to an anonymous submitter. */
  submit(input: SubmitParticipationRequest): Promise<PublicParticipationResponse>;
  /** Admin list of submissions (identity:read). */
  list(): Promise<ListParticipationsResponse>;
}

const BASE = "/api/v1/members";
// 参加届の送信だけは未認証で開放された公開エンドポイント (gateway-owned)。
const PUBLIC_SUBMIT = "/api/v1/public/participation";

export function createParticipationApi(api: ApiClient): ParticipationApi {
  return {
    listTeams: () => api.request<{ teams: MemberTeam[] }>({ method: "GET", path: `${BASE}/teams` }),
    submit: (input) =>
      api.request<PublicParticipationResponse, SubmitParticipationRequest>({
        method: "POST",
        path: PUBLIC_SUBMIT,
        body: input,
      }),
    list: () => api.request<ListParticipationsResponse>({ method: "GET", path: `${BASE}/participation` }),
  };
}
