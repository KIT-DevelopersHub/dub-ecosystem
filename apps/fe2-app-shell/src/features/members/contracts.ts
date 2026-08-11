// 運営メンバー管理 (member-management) feature contract — the wire types shared
// between this shell-local feature and the member-service backend (services/
// member-service). Kept feature-local (like mail's own types) rather than in
// @dub/types: this is an additive, self-contained domain that never leaks into the
// frozen cross-service contracts.
//
// Distinct from fe7-admin-roster (RBAC login accounts / identity users): this
// manages 運営メンバー — their invite status and which team(s) they belong to —
// the GUI replacement for the hand-maintained 組織図 PDF.

/** Invite / participation status of an 運営メンバー. Stored as these string
 *  literals in D1; the UI maps each to a JP label + colored Badge tone. */
export type MemberStatus = "added" | "invited" | "considering" | "declined";

export const MEMBER_STATUSES: readonly MemberStatus[] = ["added", "invited", "considering", "declined"];

/** A team / 班 that members are grouped under (e.g. 会場, 広報, スポンサー). */
export interface MemberTeam {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** An 運営メンバー. May belong to multiple teams (`teamIds`). */
export interface OrgMember {
  id: string;
  orgId: string;
  name: string;
  /** 担当・役割 (free text, e.g. "会場リーダー"). */
  roleTitle: string | null;
  status: MemberStatus;
  teamIds: string[];
  /** 連絡先 (任意) — email / slack / whatever. */
  contact: string | null;
  note: string | null;
  sortOrder: number;
  /** Optimistic-concurrency version; PATCH must echo the last seen value. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** One-shot payload powering all three views (list / team-grouped / org-chart). */
export interface MembersOverview {
  teams: MemberTeam[];
  members: OrgMember[];
}

export interface CreateTeamRequest {
  name: string;
  description?: string | null;
}

export interface UpdateTeamRequest {
  name?: string;
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
