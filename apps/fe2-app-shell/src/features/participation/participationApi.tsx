// 参加届 feature api adapter. Rides the ONE shell api-client (session cookie,
// 401→refresh, requestId, error normalization). Paths are /api/v1/members/* and
// resolve at the gateway to services/member-service (participation lives there,
// next to 運営メンバー管理, so submitting can reflect onto the roster in one hop).
import type { ApiClient } from "../../lib/api-client.tsx";
import type {
  ListOnboardingItemsResponse,
  ListParticipationCandidatesResponse,
  ListParticipationsResponse,
  MembersOverview,
  MemberTeam,
  OnboardingItem,
  OnboardingItemInput,
  PublicParticipationResponse,
  ResolveParticipationRequest,
  ResolveParticipationResponse,
  SubmitParticipationRequest,
  UpdateOnboardingItemRequest,
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
  /** 反映確定 (link/create/skip/unlink)。roster を書き換えるので identity:admin。 */
  resolve(id: string, body: ResolveParticipationRequest): Promise<ResolveParticipationResponse>;
  /** オンボーディング案内 (管理タブ)。閲覧 = 参加届の閲覧、書き込み = 参加届の編集。 */
  listOnboarding(): Promise<ListOnboardingItemsResponse>;
  createOnboarding(input: OnboardingItemInput): Promise<OnboardingItem>;
  updateOnboarding(id: string, patch: UpdateOnboardingItemRequest): Promise<OnboardingItem>;
  deleteOnboarding(id: string): Promise<void>;
  /** 全項目 id を新しい表示順で渡す。 */
  reorderOnboarding(ids: string[]): Promise<ListOnboardingItemsResponse>;
  /** 公開ページ用 (未ログインで読める)。 */
  publicOnboarding(): Promise<ListOnboardingItemsResponse>;
}

const BASE = "/api/v1/members";
// 参加届の送信だけは未認証で開放された公開エンドポイント (gateway-owned)。
const PUBLIC_SUBMIT = "/api/v1/public/participation";
const ONBOARDING = `${BASE}/onboarding`;

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
    listOnboarding: () => api.request<ListOnboardingItemsResponse>({ method: "GET", path: ONBOARDING }),
    createOnboarding: (input) =>
      api.request<OnboardingItem, OnboardingItemInput>({ method: "POST", path: ONBOARDING, body: input }),
    updateOnboarding: (id, patch) =>
      api.request<OnboardingItem, UpdateOnboardingItemRequest>({
        method: "PATCH",
        path: `${ONBOARDING}/${encodeURIComponent(id)}`,
        body: patch,
      }),
    deleteOnboarding: async (id) => {
      await api.request<{ ok: true }>({ method: "DELETE", path: `${ONBOARDING}/${encodeURIComponent(id)}` });
    },
    reorderOnboarding: (ids) =>
      api.request<ListOnboardingItemsResponse, { ids: string[] }>({
        method: "POST",
        path: `${ONBOARDING}/reorder`,
        body: { ids },
      }),
    publicOnboarding: () =>
      api.request<ListOnboardingItemsResponse>({ method: "GET", path: "/api/v1/public/onboarding" }),
  };
}
