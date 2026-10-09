// Service-local types for member-service (運営メンバー管理). Wire contracts come from
// the CANONICAL @dub/types `member` namespace (Team is the single shared team
// definition across all apps); this file adds only the internal persistence rows and
// injected-dependency interfaces. Distinct from identity_* (RBAC login accounts).
import type { common, member } from "@dub/types";
import type { PermissionGranter } from "@dub/policy-gate";

export type MemberStatus = member.MemberStatus;
export const MEMBER_STATUSES = ["added", "invited", "considering", "on_leave", "declined"] as const;

// ---- internal persistence rows (superset of the wire types) ----
export interface TeamRow {
  id: string;
  orgId: common.OrgId;
  key: string;
  name: string;
  color: string | null;
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
  department: string | null;
  grade: string | null;
  /** 名列番号 (例 "3EP2-26")。正規化済み (0011 additive column)。 */
  rosterNumber: string | null;
  /** Linked identity-roster account (identity userId), or null when unlinked. */
  identityUserId: string | null;
  /** 配下につくリーダーの member id（＝上長）。null は直属リーダー無し。組織図の親子関係
   *  と名簿の組織図順ソートに使う（0010 additive column）。 */
  leaderId: string | null;
  contact: string | null;
  schoolEmail: string | null;
  gmail: string | null;
  lastName: string | null;
  firstName: string | null;
  lastNameKana: string | null;
  firstNameKana: string | null;
  lastNameRomaji: string | null;
  firstNameRomaji: string | null;
  phone: string | null;
  /** 希望する活動 (参加届 由来). member_participations にしか無かった項目を名簿にも保持し、
   *  本人が アカウント設定 → 参加情報 で自己編集できるようにする (0009 additive column)。 */
  desiredActivity: member.DesiredActivity | null;
  note: string | null;
  sortOrder: number;
  version: number;
  archivedAt: common.ISODateTime | null;
  createdBy: common.UserId;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

// 参加届 persistence row (superset of the wire `Participation`). `normalizedName` is
// the space/width-folded matching key (unique per org for dedupe).
export interface ParticipationRow {
  id: string;
  orgId: common.OrgId;
  memberId: string | null;
  name: string;
  normalizedName: string;
  lastName: string | null;
  firstName: string | null;
  nameKana: string | null;
  lastNameKana: string | null;
  firstNameKana: string | null;
  nameRomaji: string | null;
  lastNameRomaji: string | null;
  firstNameRomaji: string | null;
  grade: member.Grade | null;
  department: string | null;
  /** 名列番号 (例 "3EP2-26")。正規化済み (0012 additive column)。 */
  rosterNumber: string | null;
  contact: string | null;
  phone: string | null;
  schoolEmail: string;
  gmail: string;
  desiredTeamId: string | null;
  desiredActivity: member.DesiredActivity | null;
  note: string | null;
  status: "submitted";
  matchKind: member.ParticipationMatchKind;
  reviewState: member.ParticipationReviewState;
  submittedBy: common.UserId;
  submittedAt: common.ISODateTime;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

// ---- injected dependencies (enables full HTTP-level tests with fakes) ----
export interface MemberRepo {
  // teams
  createTeam(row: TeamRow): Promise<void>;
  getTeam(id: string): Promise<TeamRow | null>;
  getTeamByKey(orgId: common.OrgId, key: string): Promise<TeamRow | null>;
  listTeams(orgId: common.OrgId): Promise<TeamRow[]>;
  updateTeam(row: TeamRow): Promise<boolean>;
  deleteTeam(id: string): Promise<void>;
  maxTeamSortOrder(orgId: common.OrgId): Promise<number>;

  // people
  createPerson(row: PersonRow, teamIds: string[]): Promise<void>;
  getPerson(id: string): Promise<PersonRow | null>;
  /** Reverse lookup: the (non-archived) person linked to an identity user, or null. */
  getPersonByIdentityUserId(orgId: common.OrgId, identityUserId: string): Promise<PersonRow | null>;
  listPeople(orgId: common.OrgId): Promise<PersonRow[]>;
  updatePerson(next: PersonRow, expectedVersion: number, teamIds?: string[]): Promise<boolean>;
  archivePerson(id: string): Promise<void>;
  maxPersonSortOrder(orgId: common.OrgId): Promise<number>;

  // team membership (person_id -> team_ids) for the whole org in one read.
  teamLinksForOrg(orgId: common.OrgId): Promise<Array<{ personId: string; teamId: string }>>;

  // participations (参加届)
  upsertParticipation(row: ParticipationRow): Promise<void>;
  getParticipation(id: string): Promise<ParticipationRow | null>;
  getParticipationByNormalizedName(orgId: common.OrgId, normalizedName: string): Promise<ParticipationRow | null>;
  listParticipations(orgId: common.OrgId): Promise<ParticipationRow[]>;
}

export interface AppDeps {
  repo: MemberRepo;
  /** Which of the requested permission keys the caller holds (identity /authz/check). The
   *  ONLY authorization dependency: src/policy-table.ts says what each route demands and
   *  @dub/policy-gate asks this port once per request. */
  authz: PermissionGranter;
  orgId: common.OrgId;
  now: () => string;
  newTeamId: () => string;
  newMemberId: () => string;
  newParticipationId: () => string;
  /** Best-effort admin notification fired when a 参加届 is submitted. Wired from
   *  env.SVC_NOTIFICATION in index.ts (buildDeps); undefined in unit tests / a deploy
   *  without the binding, in which case the submission simply skips the notify. Must
   *  never throw — the submission always succeeds regardless of notify outcome. */
  notifyParticipationSubmitted?: (
    ctx: { requestId: string; userId: string },
    participation: member.Participation,
  ) => Promise<void>;
}
