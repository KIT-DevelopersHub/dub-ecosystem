// Service-local types for member-service (運営メンバー管理). Wire contracts come from
// the CANONICAL @dub/types `member` namespace (Team is the single shared team
// definition across all apps); this file adds only the internal persistence rows and
// injected-dependency interfaces. Distinct from identity_* (RBAC login accounts).
import type { common, member } from "@dub/types";
import type { PermissionGranter } from "@dub/policy-gate";
import type { HrRepo } from "./hr-repo";
import type { HrFormRepo } from "./hr-form-repo";
import type { GoalMetricSources, GoalRepo } from "./goal-repo";
import type { SponsorImageStore, SponsorRepo } from "./sponsor-repo";
import type { SponsorLeadRepo } from "./sponsor-lead-repo";
import type { SponsorMailRepo } from "./sponsor-mail-repo";
import type { MailContactsSource } from "./sponsor-mail-service";
import type { RoleSyncPort } from "./roleSync";
import type { ProfileReminderTarget } from "./profileReminder";
import type { IdentityActivationPort } from "./identityActivation";

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
/** 名簿の永続化行。人物プロフィール項目は PersonProfile (参加届と共通) を必ず持つ。 */
export interface PersonRow extends member.PersonProfile {
  id: string;
  orgId: common.OrgId;
  name: string;
  roleTitle: string | null;
  /** 役職 (0018 additive column)。null = 未設定 (役職ロールは付かない)。 */
  position: member.MemberPosition | null;
  status: MemberStatus;
  department: string | null;
  /** 学年。旧データの表記ゆれ ("2年" / "３") は読み出し時に normalizeGrade で正規化。 */
  grade: member.Grade | null;
  /** 名列番号 (例 "3EP2-26")。正規化済み (0011 additive column)。 */
  rosterNumber: string | null;
  /** 学籍番号 (例 "1400980")。正規化済み (0016 additive column)。 */
  studentNumber: string | null;
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
export interface ParticipationRow extends member.PersonProfile {
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
  /** 学籍番号 (例 "1400980")。正規化済み (0016 additive column)。 */
  studentNumber: string | null;
  contact: string | null;
  phone: string | null;
  schoolEmail: string;
  gmail: string;
  desiredTeamId: string | null;
  /** 役職 (0018 additive column)。 */
  position: member.MemberPosition | null;
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

/** オンボーディング案内項目の永続化行 (wire `OnboardingItem` + org/作成者)。 */
export interface OnboardingItemRow {
  id: string;
  orgId: common.OrgId;
  title: string;
  description: string | null;
  url: string | null;
  sortOrder: number;
  createdBy: common.UserId;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

/** ミーティング案内の永続化行。teamId = null が全体 (DB では '')。 */
export interface OnboardingMeetingRow {
  orgId: common.OrgId;
  teamId: string | null;
  schedule: string;
  url: string | null;
  updatedBy: common.UserId;
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

  // onboarding items (オンボーディング案内), sort_order 昇順
  createOnboardingItem(row: OnboardingItemRow): Promise<void>;
  getOnboardingItem(id: string): Promise<OnboardingItemRow | null>;
  listOnboardingItems(orgId: common.OrgId): Promise<OnboardingItemRow[]>;
  updateOnboardingItem(row: OnboardingItemRow): Promise<boolean>;
  deleteOnboardingItem(id: string): Promise<void>;
  /** 指定 id 群の sort_order を一括で書き換える (並び替え)。 */
  setOnboardingSortOrders(orders: Array<{ id: string; sortOrder: number }>, updatedAt: common.ISODateTime): Promise<void>;

  // onboarding meetings (全体 / チームごと 1 件)
  listOnboardingMeetings(orgId: common.OrgId): Promise<OnboardingMeetingRow[]>;
  upsertOnboardingMeeting(row: OnboardingMeetingRow): Promise<void>;
  deleteOnboardingMeeting(orgId: common.OrgId, teamId: string | null): Promise<void>;
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
  newOnboardingItemId: () => string;
  /** 人事 (member_hr_*) の永続化。名簿リポジトリとは分けてある (hr-repo.ts)。 */
  hrRepo: HrRepo;
  /** 面談申し込みフォーム (member_hr_forms / member_hr_form_responses) の永続化 (hr-form-repo.ts)。 */
  hrFormRepo: HrFormRepo;
  /** 人事の id 採番 (app = 応募者 / hre = 履歴 / hfr = フォームの回答)。 */
  newHrId: (prefix: "app" | "hre" | "hfr") => string;
  /** スポンサー (member_sponsor_cards) の永続化 (sponsor-repo.ts)。 */
  sponsorRepo: SponsorRepo;
  /** 名刺写真の置き場 (本番 R2 SPONSOR_FILES)。undefined なら写真ルートだけ 503。 */
  sponsorImages?: SponsorImageStore;
  newSponsorCardId: () => string;
  /** スポンサー営業進捗 (member_sponsor_leads) の永続化 (sponsor-lead-repo.ts)。 */
  sponsorLeadRepo: SponsorLeadRepo;
  newSponsorLeadId: () => string;
  /** スポンサーのメール連携 (紐付けたアドレス・自動更新の履歴) の永続化 (sponsor-mail-repo.ts)。 */
  sponsorMailRepo: SponsorMailRepo;
  /** メール連携の id 採番 (mlink = 紐付け / lact = 履歴)。 */
  newSponsorMailId: (prefix: "mlink" | "lact") => string;
  /** mail-gateway のメール集計 (紐付け時の反映・一括補完)。index.ts で SVC_MAIL に結線。
   *  undefined なら紐付けだけ保存し、一括補完は 503。 */
  mailContacts?: MailContactsSource;
  /** 目標管理 (member_goals) の永続化と、他サービスの実績の取り口 (goal-repo.ts)。 */
  goalRepo: GoalRepo;
  goalSources: GoalMetricSources;
  /** チーム・役職ロールの自動付与 (identity-roster)。index.ts で SVC_IDENTITY に結線。
   *  undefined なら同期しない (単体テスト等)。名簿の保存は同期の成否に関わらず成功する。 */
  roleSync?: RoleSyncPort;
  /** 在籍で紐付いた人の招待中アカウントを有効化 (identity-roster)。index.ts で SVC_IDENTITY に
   *  結線。undefined なら有効化しない (単体テスト等)。名簿の保存は成否に関わらず成功する。 */
  identityActivation?: IdentityActivationPort;
  /** Best-effort admin notification fired when a 参加届 is submitted. Wired from
   *  env.SVC_NOTIFICATION in index.ts (buildDeps); undefined in unit tests / a deploy
   *  without the binding, in which case the submission simply skips the notify. Must
   *  never throw — the submission always succeeds regardless of notify outcome. */
  notifyParticipationSubmitted?: (
    ctx: { requestId: string; userId: string },
    participation: member.Participation,
  ) => Promise<void>;
  /** 情報が足りない本人への催促 (notification-service)。best-effort ではなく、失敗は
   *  操作した管理者へ返す。undefined なら催促できない (binding の無い環境)。 */
  sendProfileReminder?: (ctx: { requestId: string; userId: string }, target: ProfileReminderTarget) => Promise<{ deduplicated: boolean }>;
}
