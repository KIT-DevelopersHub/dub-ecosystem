// 参加届 feature contract. Wire types come from the CANONICAL @dub/types `member`
// namespace (participation lives in member-service, alongside 運営メンバー管理). Re-
// exported under local names so the screens stay decoupled from the import path.
import { member } from "@dub/types";
import type { gateway } from "@dub/types";

export type Participation = member.Participation;
export type ParticipationMatchKind = member.ParticipationMatchKind;
export type ParticipationReviewState = member.ParticipationReviewState;
export type DesiredActivity = member.DesiredActivity;
export type Grade = member.Grade;
export type SubmitParticipationRequest = member.SubmitParticipationRequest;
export type SubmitParticipationResponse = member.SubmitParticipationResponse;
export type ListParticipationsResponse = member.ListParticipationsResponse;
export type ParticipationCandidate = member.ParticipationCandidate;
export type ListParticipationCandidatesResponse = member.ListParticipationCandidatesResponse;
export type ResolveParticipationRequest = member.ResolveParticipationRequest;
export type ResolveParticipationResponse = member.ResolveParticipationResponse;
export type MemberStatus = member.MemberStatus;
/** Minimal response from the PUBLIC (unauthenticated) submit endpoint — no member echo. */
export type PublicParticipationResponse = gateway.PublicParticipationResponse;

/** Canonical shared team entity read from GET /api/v1/members/teams. */
export type MemberTeam = member.Team;

export const GRADES = member.GRADES;
export const DESIRED_ACTIVITIES = member.DESIRED_ACTIVITIES;

/** JP labels for the closed unions (form selects + サンクス copy). */
export const GRADE_LABEL: Record<Grade, string> = {
  "1": "1年",
  "2": "2年",
  "3": "3年",
  "4": "4年",
  graduate: "院生",
};
export const ACTIVITY_LABEL: Record<DesiredActivity, string> = {
  event: "イベント運営",
  dev: "チーム開発",
  both: "両方",
};

/** 管理者レビュー状態の表示ラベル（一覧の「運営メンバー反映」列）。 */
export const REVIEW_STATE_LABEL: Record<ParticipationReviewState, string> = {
  pending: "未処理",
  added: "追加済",
  skipped: "対象外",
};
