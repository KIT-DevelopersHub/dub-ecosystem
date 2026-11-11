// 人事 feature の api アダプタ。シェルの api-client (session cookie / 401→refresh / requestId /
// エラー正規化) に乗り、/api/v1/members/hr/* → gateway → member-service に届く。
// 契約型は @dub/types `hr` (SoT) をそのまま使い、ここでは再定義しない。
import type { hr, hrResult, meeting, member } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

export interface HrApi {
  list(): Promise<hr.ListApplicantsResponse>;
  get(id: string): Promise<hr.ApplicantDetail>;
  create(input: hr.CreateApplicantRequest): Promise<hr.ApplicantDetail>;
  update(id: string, body: hr.UpdateApplicantRequest): Promise<hr.Applicant>;
  moveStage(id: string, body: hr.MoveApplicantStageRequest): Promise<hr.ApplicantDetail>;
  addNote(id: string, body: hr.AddApplicantNoteRequest): Promise<hr.ApplicantDetail>;
  join(id: string, body: hr.JoinApplicantRequest): Promise<hr.JoinApplicantResponse>;
  remove(id: string): Promise<void>;
  /** 面談結果の登録 (api-gateway: 合否メール・合格はアカウント発行まで)。二度目は登録済みを返すだけ。 */
  registerResult(id: string, body: hrResult.RegisterInterviewResultRequest): Promise<hrResult.RegisterInterviewResultResponse>;
  onboarding(): Promise<hr.ListOnboardingProgressResponse>;
  setCheck(memberId: string, itemId: string, checked: boolean): Promise<hr.OnboardingProgress>;
  /** 希望チームの選択肢 (名簿のチーム一覧)。 */
  teams(): Promise<{ teams: member.Team[] }>;
  /** 定例の出席レポート (drive-share-service GET /meetings/attendance, 人事 閲覧 + hr:read)。 */
  attendance(range: { from: string; to: string }): Promise<meeting.AttendanceReportResponse>;
  /** 出席の手修正 (null = 記録を消す = 欠席)。 */
  setAttendance(meetingId: string, date: string, userId: string, status: meeting.AttendanceStatus | null): Promise<meeting.SetAttendanceResponse>;
  /** Meet の参加記録を今すぐ取り込む。 */
  ingestAttendance(body?: meeting.IngestAttendanceRequest): Promise<meeting.IngestAttendanceResponse>;
  /** 未確定の参加者 (Google アカウント) をメンバーに確定 (次回から自動)。 */
  confirmParticipant(googleUserId: string, userId: string): Promise<{ ok: true }>;
  updateAttendanceSettings(body: meeting.UpdateAttendanceSettingsRequest): Promise<meeting.AttendanceSettings>;
}

const BASE = "/api/v1/members/hr";
const enc = encodeURIComponent;

export function createHrApi(api: ApiClient): HrApi {
  return {
    list: () => api.request<hr.ListApplicantsResponse>({ method: "GET", path: `${BASE}/applicants` }),
    get: (id) => api.request<hr.ApplicantDetail>({ method: "GET", path: `${BASE}/applicants/${enc(id)}` }),
    create: (input) =>
      api.request<hr.ApplicantDetail, hr.CreateApplicantRequest>({ method: "POST", path: `${BASE}/applicants`, body: input }),
    update: (id, body) =>
      api.request<hr.Applicant, hr.UpdateApplicantRequest>({ method: "PATCH", path: `${BASE}/applicants/${enc(id)}`, body }),
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
    registerResult: (id, body) =>
      api.request<hrResult.RegisterInterviewResultResponse, hrResult.RegisterInterviewResultRequest>({
        method: "POST",
        path: `/api/v1/admin/hr/applicants/${enc(id)}/interview-result`,
        body,
      }),
    onboarding: () => api.request<hr.ListOnboardingProgressResponse>({ method: "GET", path: `${BASE}/onboarding` }),
    setCheck: (memberId, itemId, checked) =>
      api.request<hr.OnboardingProgress, hr.SetOnboardingCheckRequest>({
        method: "PUT",
        path: `${BASE}/onboarding/${enc(memberId)}/items/${enc(itemId)}`,
        body: { checked },
      }),
    teams: () => api.request<{ teams: member.Team[] }>({ method: "GET", path: "/api/v1/members/teams" }),
    attendance: ({ from, to }) =>
      api.request<meeting.AttendanceReportResponse>({ method: "GET", path: "/api/v1/meetings/attendance", query: { from, to } }),
    setAttendance: (meetingId, date, userId, status) =>
      api.request<meeting.SetAttendanceResponse, meeting.SetAttendanceRequest>({
        method: "PUT",
        path: `/api/v1/meetings/${enc(meetingId)}/attendance/${enc(date)}/${enc(userId)}`,
        body: { status },
      }),
    ingestAttendance: (body = {}) =>
      api.request<meeting.IngestAttendanceResponse, meeting.IngestAttendanceRequest>({ method: "POST", path: "/api/v1/meetings/attendance/ingest", body }),
    confirmParticipant: (googleUserId, userId) =>
      api.request<{ ok: true }, meeting.ConfirmParticipantRequest>({
        method: "PUT",
        path: `/api/v1/meetings/attendance/links/${enc(googleUserId)}`,
        body: { userId },
      }),
    updateAttendanceSettings: (body) =>
      api.request<meeting.AttendanceSettings, meeting.UpdateAttendanceSettingsRequest>({ method: "PUT", path: "/api/v1/meetings/attendance/settings", body }),
  };
}
