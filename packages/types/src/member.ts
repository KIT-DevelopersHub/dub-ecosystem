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
  /** 2-letter uppercase task-ID prefix code (e.g. "TK"). Additive/optional. */
  code?: string;
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
  /**
   * The linked identity-roster login account (identity userId), or null when this
   * 運営メンバー is not yet tied to an account. The bridge between the 組織図 (this
   * record) and RBAC/認証 (identity_users). Set/cleared via PATCH (human-confirmed).
   */
  identityUserId: string | null;
  /** 連絡先 (任意). */
  contact: string | null;
  /** 学校メールアドレス — retained on the roster from a 参加届 (任意 / additive). */
  schoolEmail?: string | null;
  /** Gmail アドレス — retained on the roster from a 参加届 (任意 / additive). */
  gmail?: string | null;
  /** 苗字(姓) — structured name retained from a 参加届 (任意 / additive). `name` stays the composed "姓 名". */
  lastName?: string | null;
  /** 名前(名) — structured name retained from a 参加届 (任意 / additive). */
  firstName?: string | null;
  /** 振り仮名(せい) — retained from a 参加届 (任意 / additive). */
  lastNameKana?: string | null;
  /** 振り仮名(めい) — retained from a 参加届 (任意 / additive). */
  firstNameKana?: string | null;
  /** 苗字(姓) ローマ字 — retained from a 参加届 (任意 / additive). アルファベットのメール発行に使う。 */
  lastNameRomaji?: string | null;
  /** 名前(名) ローマ字 — retained from a 参加届 (任意 / additive). アルファベットのメール発行に使う。 */
  firstNameRomaji?: string | null;
  /** 電話番号 — retained from a 参加届 (任意 / additive). */
  phone?: string | null;
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
  /** Set (link) or null (unlink) the identity-roster account. Omit = leave unchanged. */
  identityUserId?: string | null;
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

/** How a submitted 参加届 resolved against the existing roster. Meaningful only once
 *  an admin has reviewed the submission (`reviewState === "added"`); while `pending`
 *  it carries an inert placeholder and is not surfaced. */
export type ParticipationMatchKind = "linked_existing" | "created_new";

/** Admin review state of a 参加届 (運営メンバーへの反映は管理者が確定する).
 *  - `pending`  : 提出済・未処理（名簿には未反映）。
 *  - `added`    : 管理者が「運営メンバーに追加」を確定（`matchKind` で結合/新規を区別）。
 *  - `skipped`  : 管理者が「追加しない（対象外）」を選択。 */
export type ParticipationReviewState = "pending" | "added" | "skipped";

/** A stored 参加届 submission (admin-visible). `memberId` is the resolved 運営メンバー. */
export interface Participation {
  id: string;
  orgId: OrgId;
  memberId: string | null;
  /** 氏名 (フルネーム表示用の合成値 "姓 名"). 後方互換で常に埋まる。 */
  name: string;
  /** 苗字(姓). 分割入力の新フィールド (additive). */
  lastName: string | null;
  /** 名前(名). 分割入力の新フィールド (additive). */
  firstName: string | null;
  /** 振り仮名 (合成値 "せい めい"). */
  nameKana: string | null;
  /** 振り仮名(せい). 分割入力の新フィールド (additive). */
  lastNameKana: string | null;
  /** 振り仮名(めい). 分割入力の新フィールド (additive). */
  firstNameKana: string | null;
  /** 氏名ローマ字 (合成値 "Last First"). アルファベットのメール発行に使う (additive). */
  nameRomaji: string | null;
  /** 苗字(姓) ローマ字. 分割入力の新フィールド (additive). */
  lastNameRomaji: string | null;
  /** 名前(名) ローマ字. 分割入力の新フィールド (additive). */
  firstNameRomaji: string | null;
  grade: Grade | null;
  department: string | null;
  /** 連絡先 (email など). */
  contact: string | null;
  /** 電話番号 (任意). */
  phone: string | null;
  /** 学校メールアドレス (必須). */
  schoolEmail: string;
  /** Gmail アドレス (必須). */
  gmail: string;
  /** 希望チーム — references Team.id (canonical member_teams). */
  desiredTeamId: string | null;
  desiredActivity: DesiredActivity | null;
  /** その他 (自由記述). */
  note: string | null;
  status: "submitted";
  matchKind: ParticipationMatchKind;
  /** 管理者レビュー状態. 提出時は "pending"（名簿未反映）。管理者が確定した時のみ
   *  "added"/"skipped" になる (additive; 既存の自動反映済みデータは移行で "added")。 */
  reviewState: ParticipationReviewState;
  submittedBy: UserId;
  submittedAt: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Submit a 参加届. 姓/名 (`lastName`+`firstName`, or the legacy single `name`) and
 *  `schoolEmail`, `gmail` are required; the rest optional. The server composes
 *  `name` = "姓 名" (and `nameKana` = "せい めい") for backward compatibility when the
 *  split fields are supplied, so both new (split) and legacy (single `name`) callers work.
 *  Reaches member-service either via the authenticated POST /api/v1/members/participation
 *  or the public POST /api/v1/public/participation (gateway-owned, unauthenticated). */
export interface SubmitParticipationRequest {
  /** 苗字(姓) — 必須 (分割入力). */
  lastName?: string | null;
  /** 名前(名) — 必須 (分割入力). */
  firstName?: string | null;
  /** 氏名 (合成値). 分割入力を送らない旧クライアント向けの後方互換。姓/名 が来た時はサーバが合成する。 */
  name?: string;
  /** 学校メールアドレス (必須・メール形式). */
  schoolEmail: string;
  /** Gmail アドレス (必須・メール形式). */
  gmail: string;
  /** 振り仮名 (合成値・後方互換). 分割 (せい/めい) が来た時はサーバが合成する。 */
  nameKana?: string | null;
  /** 振り仮名(せい) (任意). */
  lastNameKana?: string | null;
  /** 振り仮名(めい) (任意). */
  firstNameKana?: string | null;
  /** 氏名ローマ字 (合成値・後方互換). 分割 (姓/名) が来た時はサーバが合成する。 */
  nameRomaji?: string | null;
  /** 苗字(姓) ローマ字 (任意・英字). アルファベットのメール発行に使う。 */
  lastNameRomaji?: string | null;
  /** 名前(名) ローマ字 (任意・英字). アルファベットのメール発行に使う。 */
  firstNameRomaji?: string | null;
  /** 電話番号 (任意・数字/ハイフン等). */
  phone?: string | null;
  grade?: Grade | null;
  department?: string | null;
  contact?: string | null;
  desiredTeamId?: string | null;
  desiredActivity?: DesiredActivity | null;
  note?: string | null;
}

/** Response of a submit: the stored 参加届. 提出時は名簿へ反映しない（管理者が一覧で
 *  確定する）ので `reviewState` は "pending"。`member` は反映されるまで null。
 *  `matchKind` は未処理時の placeholder（互換のため残置・意味を持たない）。 */
export interface SubmitParticipationResponse {
  participation: Participation;
  member: Member | null;
  matchKind: ParticipationMatchKind;
}

/** GET /api/v1/members/participation — admin list of submissions. */
export interface ListParticipationsResponse {
  participations: Participation[];
}

/** A roster member proposed as the same person behind a 参加届 (突合候補). Surfaced so
 *  the admin can confirm "招待中のこの人と同一人物" before promoting (link) instead of
 *  creating a duplicate. Ranked server-side by どの手掛かりで一致したか (email > name). */
export interface ParticipationCandidate {
  memberId: string;
  name: string;
  status: MemberStatus;
  schoolEmail: string | null;
  gmail: string | null;
  /** 対象メンバーの楽観ロック版数 (resolve link の expectedVersion に渡す)。 */
  version: number;
  /** 一致した手掛かり ("email" = 学校メール/Gmail 一致 / "name" = 氏名正規化一致)。 */
  matchedBy: Array<"email" | "name">;
}

/** GET /api/v1/members/participation/:id/candidates — 突合候補 (招待中/検討中のみ). */
export interface ListParticipationCandidatesResponse {
  candidates: ParticipationCandidate[];
}

/** POST /api/v1/members/participation/:id/resolve — 管理者が 参加届 の名簿反映を確定する。
 *  - `link`   : 既存の招待中/検討中メンバー(`memberId`)を在籍(added)へ昇格し結合（重複を作らない）。
 *               `expectedVersion` は対象メンバーの楽観ロック。
 *  - `create` : 参加届の内容から新規メンバー(added)を作成する。
 *  - `skip`   : 名簿に反映しない（対象外）。 */
export type ResolveParticipationRequest =
  | { action: "link"; memberId: string; expectedVersion: number }
  | { action: "create" }
  | { action: "skip" };

/** Response of a resolve: 更新後の 参加届 + 反映先メンバー (skip 時は null)。 */
export interface ResolveParticipationResponse {
  participation: Participation;
  member: Member | null;
}

/** Create/set a link in one call (POST /members/people/:id/identity-link). The member's
 *  version is checked for optimistic concurrency, mirroring UpdateMemberRequest. */
export interface LinkIdentityRequest {
  identityUserId: string;
  version: number;
}

/** Internal id alias (plain string, like the other common ids). */
export type MemberId = string;
export type TeamId = string;
export type ParticipationId = string;

/** Owner reference for audit/trace (created_by is internal, not on the wire Member). */
export type MemberActor = UserId;
