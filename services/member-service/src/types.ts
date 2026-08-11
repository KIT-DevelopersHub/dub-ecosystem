// Service-local types for member-service (運営メンバー管理). This is a self-contained
// domain (invite status + team membership), so its wire contracts live here rather
// than in the frozen @dub/types. Distinct from identity_* (RBAC login accounts).
import type { common, identity } from "@dub/types";
import type { MiddlewareHandler, Context } from "hono";

// ---- wire enums / entities (mirrored by the FE2 feature contract) ----
export type MemberStatus = "added" | "invited" | "considering" | "declined";
export const MEMBER_STATUSES: readonly MemberStatus[] = ["added", "invited", "considering", "declined"];

export interface MemberTeam {
  id: string;
  orgId: common.OrgId;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

export interface OrgMember {
  id: string;
  orgId: common.OrgId;
  name: string;
  roleTitle: string | null;
  status: MemberStatus;
  teamIds: string[];
  contact: string | null;
  note: string | null;
  sortOrder: number;
  version: number;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

export interface MembersOverview {
  teams: MemberTeam[];
  members: OrgMember[];
}

// ---- request contracts ----
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
export interface UpdateMemberRequest extends common.Versioned {
  name?: string;
  roleTitle?: string | null;
  status?: MemberStatus;
  teamIds?: string[];
  contact?: string | null;
  note?: string | null;
  sortOrder?: number;
}

// ---- internal persistence rows (superset of wire types; created_by is internal) ----
export interface TeamRow {
  id: string;
  orgId: common.OrgId;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}
export interface PersonRow {
  id: string;
  orgId: common.OrgId;
  name: string;
  roleTitle: string | null;
  status: MemberStatus;
  contact: string | null;
  note: string | null;
  sortOrder: number;
  version: number;
  archivedAt: common.ISODateTime | null;
  createdBy: common.UserId;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

// ---- injected dependencies (enables full HTTP-level tests with fakes) ----
export interface Authz {
  requireAuth(): MiddlewareHandler;
  requirePermission(
    permission: identity.PermissionKey,
    resolve?: (c: Context) => { orgId?: string; resourceType?: string; resourceId?: string },
  ): MiddlewareHandler;
  hasPermission(userId: common.UserId, orgId: common.OrgId, query: identity.AuthzQuery): Promise<boolean>;
}

export interface MemberRepo {
  // teams
  createTeam(row: TeamRow): Promise<void>;
  getTeam(id: string): Promise<TeamRow | null>;
  listTeams(orgId: common.OrgId): Promise<TeamRow[]>;
  updateTeam(row: TeamRow): Promise<boolean>;
  deleteTeam(id: string): Promise<void>;
  maxTeamSortOrder(orgId: common.OrgId): Promise<number>;

  // people
  createPerson(row: PersonRow, teamIds: string[]): Promise<void>;
  getPerson(id: string): Promise<PersonRow | null>;
  listPeople(orgId: common.OrgId): Promise<PersonRow[]>;
  // Optimistic write: UPDATE ... WHERE id=? AND version=expected. Returns false on
  // version mismatch / not found. When teamIds is provided the join set is replaced.
  updatePerson(next: PersonRow, expectedVersion: number, teamIds?: string[]): Promise<boolean>;
  archivePerson(id: string): Promise<void>;
  maxPersonSortOrder(orgId: common.OrgId): Promise<number>;

  // team membership (person_id -> team_ids), for the whole org in one read.
  teamLinksForOrg(orgId: common.OrgId): Promise<Array<{ personId: string; teamId: string }>>;
}

export interface AppDeps {
  repo: MemberRepo;
  authz: Authz;
  orgId: common.OrgId;
  now: () => string;
  newTeamId: () => string;
  newMemberId: () => string;
}
