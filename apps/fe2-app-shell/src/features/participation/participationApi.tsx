// 参加届 feature api adapter. Rides the ONE shell api-client (session cookie,
// 401→refresh, requestId, error normalization). Paths are /api/v1/members/* and
// resolve at the gateway to services/member-service (participation lives there,
// next to 運営メンバー管理, so submitting can reflect onto the roster in one hop).
import type { ApiClient } from "../../lib/api-client.tsx";
import type {
  ListParticipationCandidatesResponse,
  ListParticipationsResponse,
  MembersOverview,
  MemberTeam,
  PublicParticipationResponse,
  ResolveParticipationRequest,
  ResolveParticipationResponse,
  SubmitParticipationRequest,
} from "./contracts.ts";

export interface ParticipationApi {
  /** Canonical team list, to populate the 希望チーム select (identity:read). */
  listTeams(): Promise<{ teams: MemberTeam[] }>;
  /** Submit a 参加届 via the PUBLIC (unauthenticated) endpoint. 提出は 参加届 を記録する
   *  だけで名簿へは反映しない（管理者が一覧で確定する）。応答は最小（accepted のみ）。 */
  submit(input: SubmitParticipationRequest): Promise<PublicParticipationResponse>;
  /** Admin list of submissions (identity:read). */
  list(): Promise<ListParticipationsResponse>;
  /** 突合候補（招待中/検討中で氏名/メール一致）を取得 (identity:read)。 */
  candidates(id: string): Promise<ListParticipationCandidatesResponse>;
  /** 名簿全体（手動紐付けの検索対象）を取得 (identity:read)。既存の overview を流用。 */
  overview(): Promise<MembersOverview>;
  /** 反映確定 (link/create/skip)。roster を書き換えるので identity:admin。 */
  resolve(id: string, body: ResolveParticipationRequest): Promise<ResolveParticipationResponse>;
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
    candidates: (id) =>
      api.request<ListParticipationCandidatesResponse>({
        method: "GET",
        path: `${BASE}/participation/${encodeURIComponent(id)}/candidates`,
      }),
    overview: () => api.request<MembersOverview>({ method: "GET", path: `${BASE}/overview` }),
    resolve: (id, body) =>
      api.request<ResolveParticipationResponse, ResolveParticipationRequest>({
        method: "POST",
        path: `${BASE}/participation/${encodeURIComponent(id)}/resolve`,
        body,
      }),
  };
}
