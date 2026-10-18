// 参加届 feature api adapter. Rides the ONE shell api-client (session cookie,
// 401→refresh, requestId, error normalization). Paths are /api/v1/members/* and
// resolve at the gateway to services/member-service (participation lives there,
// next to 運営メンバー管理, so submitting can reflect onto the roster in one hop).
import type { ApiClient } from "../../lib/api-client.tsx";
import type { auth, common, identity } from "@dub/types";
import type {
  ListOnboardingItemsResponse,
  ListParticipationCandidatesResponse,
  ListParticipationsResponse,
  MembersOverview,
  MemberTeam,
  OnboardingGuide,
  OnboardingItem,
  OnboardingItemInput,
  PublicParticipationResponse,
  SaveOnboardingMeetingRequest,
  SaveOnboardingMeetingResponse,
  ResolveParticipationRequest,
  ResolveParticipationResponse,
  SubmitParticipationRequest,
  UpdateOnboardingItemRequest,
  RosterMember,
} from "./contracts.ts";

/** 発行済み受信アドレス (mail-gateway POST /issued-addresses の応答のうち使う分)。 */
export interface IssuedMailAddress {
  id: string;
  address: string;
}

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
  listOnboarding(): Promise<OnboardingGuide>;
  createOnboarding(input: OnboardingItemInput): Promise<OnboardingItem>;
  updateOnboarding(id: string, patch: UpdateOnboardingItemRequest): Promise<OnboardingItem>;
  deleteOnboarding(id: string): Promise<void>;
  /** 全項目 id を新しい表示順で渡す。 */
  reorderOnboarding(ids: string[]): Promise<ListOnboardingItemsResponse>;
  /** 全体 / チームのミーティング案内を保存 (schedule null で削除)。 */
  saveOnboardingMeeting(input: SaveOnboardingMeetingRequest): Promise<SaveOnboardingMeetingResponse>;
  /** 公開ページ用 (未ログインで読める)。 */
  publicOnboarding(): Promise<OnboardingGuide>;
  /** 追加と同時のメール発行で付けるロールの候補 (identity:read)。 */
  listRoles(): Promise<identity.Role[]>;
  /** @developershub.jp の受信アドレスを発行 (mail:admin)。 */
  issueMailAddress(localPart: string): Promise<IssuedMailAddress>;
  /** 発行したアドレスでログインアカウントを作りロールを付与 (identity:admin)。 */
  inviteAccount(input: identity.InviteUserRequest): Promise<identity.IdentityUser>;
  /** 運営メンバーをログインアカウントに紐付け (運営メンバーの編集)。 */
  linkAccount(memberId: string, input: { identityUserId: string; version: number }): Promise<RosterMember>;
  /** アカウント発行メール: login + password to the member's Gmail (identity:admin)。 */
  sendAccountMail(identityUserId: string): Promise<auth.AdminSendAccountMailResponse>;
}

const BASE = "/api/v1/members";
// 参加届の送信だけは未認証で開放された公開エンドポイント (gateway-owned)。
const PUBLIC_SUBMIT = "/api/v1/public/participation";
const ONBOARDING = `${BASE}/onboarding`;
const ROLE_PAGE_LIMIT = 100;

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
    listOnboarding: () => api.request<OnboardingGuide>({ method: "GET", path: ONBOARDING }),
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
    saveOnboardingMeeting: (input) =>
      api.request<SaveOnboardingMeetingResponse, SaveOnboardingMeetingRequest>({
        method: "PUT",
        path: `${ONBOARDING}/meetings`,
        body: input,
      }),
    publicOnboarding: () => api.request<OnboardingGuide>({ method: "GET", path: "/api/v1/public/onboarding" }),
    listRoles: async () => {
      const page = await api.request<common.Paginated<identity.Role>>({
        method: "GET",
        path: "/api/v1/identity/roles",
        query: { limit: ROLE_PAGE_LIMIT },
      });
      return page.items;
    },
    issueMailAddress: (localPart) =>
      api.request<IssuedMailAddress, { localPart: string }>({
        method: "POST",
        path: "/api/v1/mail/admin/email-routing/issued-addresses",
        body: { localPart },
      }),
    inviteAccount: async (input) => {
      const res = await api.request<{ user: identity.IdentityUser }, identity.InviteUserRequest>({
        method: "POST",
        path: "/api/v1/identity/users/invite",
        body: input,
      });
      return res.user;
    },
    linkAccount: (memberId, input) =>
      api.request<RosterMember, { identityUserId: string; version: number }>({
        method: "POST",
        path: `${BASE}/people/${encodeURIComponent(memberId)}/identity-link`,
        body: input,
      }),
    sendAccountMail: (identityUserId) =>
      api.request<auth.AdminSendAccountMailResponse>({
        method: "POST",
        path: `/api/v1/admin/users/${encodeURIComponent(identityUserId)}/account-mail`,
        body: {},
      }),
  };
}
