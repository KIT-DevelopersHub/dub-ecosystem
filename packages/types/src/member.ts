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
  /** 学科 (任意). かつてメモ欄に混在していたのを専用フィールドへ分離。 */
  department: string | null;
  /** 学年 (任意, 自由記述: 例 "3年" / "M1"). メモ欄から専用フィールドへ分離。 */
  grade: string | null;
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
  department?: string | null;
  grade?: string | null;
  contact?: string | null;
  note?: string | null;
}
export interface UpdateMemberRequest {
  name?: string;
  roleTitle?: string | null;
  status?: MemberStatus;
  teamIds?: string[];
  department?: string | null;
  grade?: string | null;
  contact?: string | null;
  note?: string | null;
  sortOrder?: number;
  /** Required: the version the edit was based on (409 on mismatch). */
  version: number;
}

/** Internal id alias (plain string, like the other common ids). */
export type MemberId = string;
export type TeamId = string;

/** Owner reference for audit/trace (created_by is internal, not on the wire Member). */
export type MemberActor = UserId;
