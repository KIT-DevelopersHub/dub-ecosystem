// member — 運営メンバー管理 (member-service). CANONICAL, cross-app contracts.
//
// `Team` here is the SINGLE shared definition of a team across ALL apps: member-
// service owns the data (source of truth) and serves it at GET /api/v1/members/teams;
// other apps (e.g. gantt) import this type and read that endpoint to power their own
// team switchers. Keep the Team shape STABLE — id / key / name / color / description.
import type { OrgId, UserId, ISODateTime } from "./common";

/** Invite / participation status of an 運営メンバー. Closed union (contract change to extend). */
export type MemberStatus = "added" | "invited" | "considering" | "declined";
export const MEMBER_STATUSES: readonly MemberStatus[] = ["added", "invited", "considering", "declined"];

/**
 * A team / 班. The canonical shared entity — this exact shape is what every app
 * consumes. `key` is a stable, URL-safe slug (unique within an org) that other apps
 * can persist as a reference instead of the opaque `id`. `color` is an optional hex
 * (e.g. "#4f46e5") for consistent team coloring across apps.
 */
export interface Team {
  id: string;
  key: string;
  name: string;
  color: string | null;
  description: string | null;
}

/** An 運営メンバー. May belong to multiple teams (`teamIds` reference Team.id). */
export interface Member {
  id: string;
  orgId: OrgId;
  name: string;
  /** 担当・役割 (free text, e.g. "会場リーダー"). */
  roleTitle: string | null;
  status: MemberStatus;
  teamIds: string[];
  /** 連絡先 (任意). */
  contact: string | null;
  note: string | null;
  sortOrder: number;
  /** Optimistic-concurrency version; PATCH must echo the last seen value. */
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** One-shot payload powering the member-management views (list / team / org-chart). */
export interface MembersOverview {
  teams: Team[];
  members: Member[];
}

/** Dedicated team-list response (GET /api/v1/members/teams) — the source other apps read. */
export interface ListTeamsResponse {
  teams: Team[];
}

// ---- request contracts ----
export interface CreateTeamRequest {
  name: string;
  /** Optional slug; derived from name when omitted. */
  key?: string;
  color?: string | null;
  description?: string | null;
}
export interface UpdateTeamRequest {
  name?: string;
  key?: string;
  color?: string | null;
  description?: string | null;
  sortOrder?: number;
}
export interface CreateMemberRequest {
  name: string;
  roleTitle?: string | null;
  status: MemberStatus;
  teamIds: string[];
  contact?: string | null;
  note?: string | null;
}
export interface UpdateMemberRequest {
  name?: string;
  roleTitle?: string | null;
  status?: MemberStatus;
  teamIds?: string[];
  contact?: string | null;
  note?: string | null;
  sortOrder?: number;
  /** Required: the version the edit was based on (409 on mismatch). */
  version: number;
}

// ---- 参加届 (participation submissions) --------------------------------------------
// A 参加届 is a person's self-submitted intent to join. On submit, member-service
// resolves it to a member_people row (invited -> added, or a new added person) so the
// roster reflects reality without a manual import. Fields traced from leaders-meetup-
// bot's participation_forms, mapped onto the DevHub member model.

/** 希望する活動 (activity preference). Optional free-choice; null when unspecified. */
export type DesiredActivity = "event" | "dev" | "both";
export const DESIRED_ACTIVITIES: readonly DesiredActivity[] = ["event", "dev", "both"];

/** 学年. Loose union: DevHub keeps lmb's set (1〜4 + 院生). Optional on the form. */
export type Grade = "1" | "2" | "3" | "4" | "graduate";
export const GRADES: readonly Grade[] = ["1", "2", "3", "4", "graduate"];

/** How a submitted 参加届 resolved against the existing roster. */
export type ParticipationMatchKind = "linked_existing" | "created_new";

/** A stored 参加届 submission (admin-visible). `memberId` is the resolved 運営メンバー. */
export interface Participation {
  id: string;
  orgId: OrgId;
  memberId: string | null;
  name: string;
  nameKana: string | null;
  grade: Grade | null;
  department: string | null;
  /** 連絡先 (email など). */
  contact: string | null;
  /** 希望チーム — references Team.id (canonical member_teams). */
  desiredTeamId: string | null;
  desiredActivity: DesiredActivity | null;
  /** その他 (自由記述). */
  note: string | null;
  status: "submitted";
  matchKind: ParticipationMatchKind;
  submittedBy: UserId;
  submittedAt: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** POST /api/v1/members/participation — submit a 参加届 (name required, rest optional). */
export interface SubmitParticipationRequest {
  name: string;
  nameKana?: string | null;
  grade?: Grade | null;
  department?: string | null;
  contact?: string | null;
  desiredTeamId?: string | null;
  desiredActivity?: DesiredActivity | null;
  note?: string | null;
}

/** Response of a submit: the stored 参加届 + the resolved member + how it matched. */
export interface SubmitParticipationResponse {
  participation: Participation;
  member: Member;
  matchKind: ParticipationMatchKind;
}

/** GET /api/v1/members/participation — admin list of submissions. */
export interface ListParticipationsResponse {
  participations: Participation[];
}

/** Internal id alias (plain string, like the other common ids). */
export type MemberId = string;
export type TeamId = string;
export type ParticipationId = string;

/** Owner reference for audit/trace (created_by is internal, not on the wire Member). */
export type MemberActor = UserId;
