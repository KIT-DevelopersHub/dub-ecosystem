// 運営メンバー管理 feature contract. The wire types are the CANONICAL @dub/types
// `member` namespace — `Team` is the single shared team definition across all apps
// (member-service is the source of truth; other apps read GET /api/v1/members/teams).
// This module just re-exports them under the feature's local names so the screens
// stay decoupled from the import path.
import { member } from "@dub/types";

export type MemberStatus = member.MemberStatus;
export const MEMBER_STATUSES = member.MEMBER_STATUSES;

/** Canonical shared team entity: { id, key, name, color?, description? }. */
export type MemberTeam = member.Team;
export type OrgMember = member.Member;
export type MembersOverview = member.MembersOverview;

export type CreateTeamRequest = member.CreateTeamRequest;
export type UpdateTeamRequest = member.UpdateTeamRequest;
export type CreateMemberRequest = member.CreateMemberRequest;
export type UpdateMemberRequest = member.UpdateMemberRequest;
export type LinkIdentityRequest = member.LinkIdentityRequest;
