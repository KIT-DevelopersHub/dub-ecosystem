// 人事 feature の api アダプタ。シェルの api-client (session cookie / 401→refresh / requestId /
// エラー正規化) に乗り、/api/v1/members/hr/* → gateway → member-service に届く。
// 契約型は @dub/types `hr` (SoT) をそのまま使い、ここでは再定義しない。
import type { hr, member } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

export interface HrApi {
  list(): Promise<hr.ListApplicantsResponse>;
  get(id: string): Promise<hr.ApplicantDetail>;
  create(input: hr.CreateApplicantRequest): Promise<hr.ApplicantDetail>;
  moveStage(id: string, body: hr.MoveApplicantStageRequest): Promise<hr.ApplicantDetail>;
  addNote(id: string, body: hr.AddApplicantNoteRequest): Promise<hr.ApplicantDetail>;
  join(id: string, body: hr.JoinApplicantRequest): Promise<hr.JoinApplicantResponse>;
  remove(id: string): Promise<void>;
  onboarding(): Promise<hr.ListOnboardingProgressResponse>;
  setCheck(memberId: string, itemId: string, checked: boolean): Promise<hr.OnboardingProgress>;
  /** 希望チームの選択肢 (名簿のチーム一覧)。 */
  teams(): Promise<{ teams: member.Team[] }>;
}

const BASE = "/api/v1/members/hr";
const enc = encodeURIComponent;

export function createHrApi(api: ApiClient): HrApi {
  return {
    list: () => api.request<hr.ListApplicantsResponse>({ method: "GET", path: `${BASE}/applicants` }),
    get: (id) => api.request<hr.ApplicantDetail>({ method: "GET", path: `${BASE}/applicants/${enc(id)}` }),
    create: (input) =>
      api.request<hr.ApplicantDetail, hr.CreateApplicantRequest>({ method: "POST", path: `${BASE}/applicants`, body: input }),
    moveStage: (id, body) =>
      api.request<hr.ApplicantDetail, hr.MoveApplicantStageRequest>({
        method: "POST",
        path: `${BASE}/applicants/${enc(id)}/stage`,
        body,
      }),
    addNote: (id, body) =>
      api.request<hr.ApplicantDetail, hr.AddApplicantNoteRequest>({
        method: "POST",
        path: `${BASE}/applicants/${enc(id)}/notes`,
        body,
      }),
    join: (id, body) =>
      api.request<hr.JoinApplicantResponse, hr.JoinApplicantRequest>({
        method: "POST",
        path: `${BASE}/applicants/${enc(id)}/join`,
        body,
      }),
    remove: async (id) => {
      await api.request<{ ok: true }>({ method: "DELETE", path: `${BASE}/applicants/${enc(id)}` });
    },
    onboarding: () => api.request<hr.ListOnboardingProgressResponse>({ method: "GET", path: `${BASE}/onboarding` }),
    setCheck: (memberId, itemId, checked) =>
      api.request<hr.OnboardingProgress, hr.SetOnboardingCheckRequest>({
        method: "PUT",
        path: `${BASE}/onboarding/${enc(memberId)}/items/${enc(itemId)}`,
        body: { checked },
      }),
    teams: () => api.request<{ teams: member.Team[] }>({ method: "GET", path: "/api/v1/members/teams" }),
  };
}
