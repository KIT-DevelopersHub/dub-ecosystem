// member — 運営メンバー管理 (member-service). CANONICAL, cross-app contracts.
//
// `Team` here is the SINGLE shared definition of a team across ALL apps: member-
// service owns the data (source of truth) and serves it at GET /api/v1/members/teams;
// other apps (e.g. gantt) import this type and read that endpoint to power their own
// team switchers. Keep the Team shape STABLE — id / key / name / color / description.
import type { OrgId, UserId, ISODateTime } from "./common";

/** Invite / participation status of an 運営メンバー. Closed union (contract change to extend).
 *  - added / invited / considering : 在籍系（UI では「在籍中」に統合表示）。invited と
 *    considering は同義（招待中 == 検討中）で、名簿上は added と同じ「在籍中」として扱う。
 *  - on_leave : 一時離脱（「休み中」）。休職とは別で、名簿には残るが稼働していない状態。additive。
 *  - declined : 辞退。名簿 UI からは隠すがデータは保持し「辞退者」ビューで参照する。 */
export type MemberStatus = "added" | "invited" | "considering" | "on_leave" | "declined";
export const MEMBER_STATUSES: readonly MemberStatus[] = ["added", "invited", "considering", "on_leave", "declined"];

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

/** An 運営メンバー. May belong to multiple teams (`teamIds` reference Team.id).
 *  人物プロフィール項目は PersonProfile（参加届と共通）を継承する。運営固有の項目
 *  (役割/ステータス/チーム/リーダー/連絡先/アカウント紐付け) だけをここに持つ。 */
export interface Member extends PersonProfile {
  id: string;
  orgId: OrgId;
  /** 氏名 (表示用の合成値 "姓 名"). 姓/名 が無い旧データは単一値のまま。 */
  name: string;
  /** 担当・役割 (free text, e.g. "会場リーダー"). */
  roleTitle: string | null;
  status: MemberStatus;
  teamIds: string[];
  /**
   * The linked identity-roster login account (identity userId), or null when this
   * 運営メンバー is not yet tied to an account. The bridge between the 組織図 (this
   * record) and RBAC/認証 (identity_users). Set/cleared via PATCH (human-confirmed).
   */
  identityUserId: string | null;
  /**
   * このメンバーが配下につく「リーダー」の member id（＝上長）。null は直属リーダー無し
   * （オーガナイザー／統括や未割り当て）。組織図の親子関係と名簿の組織図順ソートに使う。
   * 同一 org 内の別 member を指す自己参照（自分自身は不可）。additive・任意。
   */
  leaderId?: string | null;
  /** 連絡先 (任意・運営用). */
  contact: string | null;
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
/** 追加。人物プロフィール項目は PersonProfile と共通 (任意・省略は null)。`name` は
 *  姓/名 から合成するので、姓/名 を送るなら省略可。 */
export interface CreateMemberRequest extends Partial<PersonProfile> {
  name?: string;
  roleTitle?: string | null;
  status: MemberStatus;
  teamIds: string[];
  /** 配下につくリーダーの member id（任意・additive）。 */
  leaderId?: string | null;
  contact?: string | null;
}
/** 更新。人物プロフィール項目は PersonProfile と共通 (null で解除・省略で変更なし)。
 *  姓/名 のどちらかを送ると `name` はサーバが合成し直す。 */
export interface UpdateMemberRequest extends Partial<PersonProfile> {
  name?: string;
  roleTitle?: string | null;
  status?: MemberStatus;
  teamIds?: string[];
  /** Set (link) or null (unlink) the identity-roster account. Omit = leave unchanged. */
  identityUserId?: string | null;
  /** 配下につくリーダーの member id。null で解除。省略で変更なし（任意・additive）。 */
  leaderId?: string | null;
  contact?: string | null;
  sortOrder?: number;
  /** Required: the version the edit was based on (409 on mismatch). */
  version: number;
}

// ---- 人物プロフィール (運営名簿と参加届の共通エンティティ) -------------------------------
// 運営名簿 (Member)・参加届 (Participation)・本人の参加情報 (SelfParticipation) は、同じ
// 人物項目をこの PersonProfile から継承する。項目の追加・変更はここ 1 か所で行い、
// PERSON_PROFILE_KEYS / PERSON_PROFILE_LABEL / parsePersonProfileField を合わせて更新する
// (キー集合は型で網羅検査しているので、漏れるとコンパイルエラーになる)。

/** 希望する活動 (activity preference). Optional free-choice; null when unspecified. */
export type DesiredActivity = "event" | "dev" | "both";
export const DESIRED_ACTIVITIES: readonly DesiredActivity[] = ["event", "dev", "both"];

/** 学年. 1〜4 + 院生。 */
export type Grade = "1" | "2" | "3" | "4" | "graduate";
export const GRADES: readonly Grade[] = ["1", "2", "3", "4", "graduate"];

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

export interface PersonProfile {
  /** 苗字(姓). */
  lastName: string | null;
  /** 名前(名). */
  firstName: string | null;
  /** 振り仮名(せい). */
  lastNameKana: string | null;
  /** 振り仮名(めい). */
  firstNameKana: string | null;
  /** 苗字(姓) ローマ字. アルファベットのメール発行に使う。 */
  lastNameRomaji: string | null;
  /** 名前(名) ローマ字. */
  firstNameRomaji: string | null;
  /** 学校メールアドレス. */
  schoolEmail: string | null;
  /** Gmail アドレス. */
  gmail: string | null;
  /** 電話番号. */
  phone: string | null;
  grade: Grade | null;
  /** 学科. */
  department: string | null;
  /** 名列番号 (例 "3EP2-26"). normalizeRosterNumber で正規化済み。 */
  rosterNumber: string | null;
  desiredActivity: DesiredActivity | null;
  /** 備考 (連絡事項など). */
  note: string | null;
}
export type PersonProfileKey = keyof PersonProfile;

/** 表示順を兼ねる全キー。PersonProfile と 1:1 (下の型検査で漏れを禁止)。 */
export const PERSON_PROFILE_KEYS = [
  "lastName",
  "firstName",
  "lastNameKana",
  "firstNameKana",
  "lastNameRomaji",
  "firstNameRomaji",
  "schoolEmail",
  "gmail",
  "phone",
  "grade",
  "department",
  "rosterNumber",
  "desiredActivity",
  "note",
] as const satisfies readonly PersonProfileKey[];
type MissingProfileKeys = Exclude<PersonProfileKey, (typeof PERSON_PROFILE_KEYS)[number]>;
const _profileKeysExhaustive: [MissingProfileKeys] extends [never] ? true : MissingProfileKeys = true;
void _profileKeysExhaustive;

/** 画面・ダウンロード・通知で共通の項目名。 */
export const PERSON_PROFILE_LABEL: Record<PersonProfileKey, string> = {
  lastName: "氏名（苗字）",
  firstName: "氏名（名前）",
  lastNameKana: "ふりがな（せい）",
  firstNameKana: "ふりがな（めい）",
  lastNameRomaji: "ローマ字（姓）",
  firstNameRomaji: "ローマ字（名）",
  schoolEmail: "学校のメールアドレス",
  gmail: "Gmail アドレス",
  phone: "電話番号",
  grade: "学年",
  department: "学科",
  rosterNumber: "名列番号",
  desiredActivity: "希望する活動",
  note: "備考",
};

export function emptyPersonProfile(): PersonProfile {
  return Object.fromEntries(PERSON_PROFILE_KEYS.map((k) => [k, null])) as unknown as PersonProfile;
}

/** 表示用の文字列 (学年・希望活動はラベル、未入力は "")。画面・通知で共通。 */
export function formatPersonProfileValue(key: PersonProfileKey, p: Partial<PersonProfile>): string {
  if (key === "grade") return p.grade ? GRADE_LABEL[p.grade] : "";
  if (key === "desiredActivity") return p.desiredActivity ? ACTIVITY_LABEL[p.desiredActivity] : "";
  return p[key] ?? "";
}

/** PersonProfile 部分だけを取り出す (Member / Participation から)。 */
export function pickPersonProfile(src: PersonProfile): PersonProfile {
  return Object.fromEntries(PERSON_PROFILE_KEYS.map((k) => [k, src[k]])) as unknown as PersonProfile;
}

// ---- 名列番号 ----
/** 名列番号の形式: 学年(数字1) + 学科(英字1-4) + クラス(数字1-2) + "-" + 番号(数字1-3)。例 "3EP2-26"。 */
export const ROSTER_NUMBER_PATTERN = /^[0-9][A-Z]{1,4}[0-9]{1,2}-[0-9]{1,3}$/;

/** 全角→半角・小文字→大文字・ハイフン類の統一・空白除去。空なら null。形式検証は呼び出し側で。 */
export function normalizeRosterNumber(raw: string): string | null {
  const s = raw
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\u30FC\uFF70]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
  return s.length === 0 ? null : s;
}

/** 学年の表記ゆれを吸収する ("3" / "３" / "3年" / "3年生" / "M1" / "院生" / "graduate")。
 *  空は null、解釈できなければ undefined。 */
export function normalizeGrade(raw: string): Grade | null | undefined {
  const s = raw.normalize("NFKC").replace(/\s+/g, "");
  if (s.length === 0) return null;
  if ((GRADES as readonly string[]).includes(s)) return s as Grade;
  const m = /^([1-4])年生?$/.exec(s);
  if (m) return m[1] as Grade;
  if (/^(院生?|大学院|修士|博士|[MDmd][1-3]$)/.test(s)) return "graduate";
  return undefined;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[0-9+\-()\s]{6,20}$/;
/** 先頭は英字、以降は英字/空白/ハイフン/アポストロフィ (O'Brien 等)。 */
const ROMAJI_RE = /^[A-Za-z][A-Za-z\s'-]*$/;

/** 形式エラー時に入力欄へ出す文言。 */
export const PERSON_PROFILE_ERROR: Partial<Record<PersonProfileKey, string>> = {
  lastNameRomaji: "英字（ローマ字）で入力してください",
  firstNameRomaji: "英字（ローマ字）で入力してください",
  schoolEmail: "メールアドレスの形式が正しくありません",
  gmail: "メールアドレスの形式が正しくありません",
  phone: "電話番号の形式が正しくありません",
  grade: "学年を選択肢から選んでください",
  rosterNumber: "名列番号は 3EP2-26 の形式で入力してください",
  desiredActivity: "希望する活動を選択肢から選んでください",
};

export type ParsedProfileField<K extends PersonProfileKey> = { ok: true; value: PersonProfile[K] } | { ok: false };

/** 1 項目の正規化 + 形式検証。フロント・gateway・member-service の全経路がこれを使う。
 *  空文字/null/undefined は null (=未入力)。必須かどうかは呼び出し側で判定する。 */
export function parsePersonProfileField<K extends PersonProfileKey>(key: K, raw: unknown): ParsedProfileField<K> {
  const ok = (value: unknown): ParsedProfileField<K> => ({ ok: true, value: value as PersonProfile[K] });
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "string") return { ok: false };
  const t = raw.trim();
  if (t.length === 0) return ok(null);
  switch (key) {
    case "schoolEmail":
    case "gmail":
      return EMAIL_RE.test(t) ? ok(t) : { ok: false };
    case "phone":
      return PHONE_RE.test(t) ? ok(t) : { ok: false };
    case "lastNameRomaji":
    case "firstNameRomaji":
      return ROMAJI_RE.test(t) ? ok(t) : { ok: false };
    case "rosterNumber": {
      const n = normalizeRosterNumber(t);
      return n !== null && ROSTER_NUMBER_PATTERN.test(n) ? ok(n) : { ok: false };
    }
    case "grade": {
      const g = normalizeGrade(t);
      return g === undefined ? { ok: false } : ok(g);
    }
    case "desiredActivity":
      return (DESIRED_ACTIVITIES as readonly string[]).includes(t) ? ok(t) : { ok: false };
    default:
      return ok(t);
  }
}

/** 渡されたキーだけを検証して Partial<PersonProfile> にする。不正なキーは errors に入る。 */
export function parsePersonProfilePatch(raw: Record<string, unknown>): {
  value: Partial<PersonProfile>;
  errors: PersonProfileKey[];
} {
  const value: Partial<PersonProfile> = {};
  const errors: PersonProfileKey[] = [];
  for (const k of PERSON_PROFILE_KEYS) {
    if (!(k in raw)) continue;
    const r = parsePersonProfileField(k, raw[k]);
    if (r.ok) (value as Record<string, unknown>)[k] = r.value;
    else errors.push(k);
  }
  return { value, errors };
}

// ---- 参加届 (participation submissions) --------------------------------------------
// A 参加届 is a person's self-submitted intent to join. On submit, member-service
// resolves it to a member_people row (invited -> added, or a new added person) so the
// roster reflects reality without a manual import. Fields traced from leaders-meetup-
// bot's participation_forms, mapped onto the DevHub member model.

/** How a submitted 参加届 resolved against the existing roster. Meaningful only once
 *  an admin has reviewed the submission (`reviewState === "added"`); while `pending`
 *  it carries an inert placeholder and is not surfaced. */
export type ParticipationMatchKind = "linked_existing" | "created_new";

/** Admin review state of a 参加届 (運営メンバーへの反映は管理者が確定する).
 *  - `pending`  : 提出済・未処理（名簿には未反映）。
 *  - `added`    : 管理者が「運営メンバーに追加」を確定（`matchKind` で結合/新規を区別）。
 *  - `skipped`  : 管理者が「追加しない（対象外）」を選択。 */
export type ParticipationReviewState = "pending" | "added" | "skipped";

/** A stored 参加届 submission (admin-visible). `memberId` is the resolved 運営メンバー.
 *  人物プロフィール項目は PersonProfile（運営名簿と共通）を継承する。 */
export interface Participation extends PersonProfile {
  id: string;
  orgId: OrgId;
  memberId: string | null;
  /** 氏名 (フルネーム表示用の合成値 "姓 名"). 後方互換で常に埋まる。 */
  name: string;
  /** 振り仮名 (合成値 "せい めい"). */
  nameKana: string | null;
  /** 氏名ローマ字 (合成値 "Last First"). */
  nameRomaji: string | null;
  /** 連絡先 (旧フォームの名残・現フォームは送らない). */
  contact: string | null;
  /** 学校メールアドレス (参加届では必須). */
  schoolEmail: string;
  /** Gmail アドレス (参加届では必須). */
  gmail: string;
  /** 希望チーム — references Team.id (canonical member_teams). */
  desiredTeamId: string | null;
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
export interface SubmitParticipationRequest extends Partial<PersonProfile> {
  /** 氏名 (合成値). 分割入力を送らない旧クライアント向けの後方互換。姓/名 が来た時はサーバが合成する。 */
  name?: string;
  /** 学校メールアドレス (必須・メール形式). */
  schoolEmail: string;
  /** Gmail アドレス (必須・メール形式). */
  gmail: string;
  /** 振り仮名 (合成値・後方互換). 分割 (せい/めい) が来た時はサーバが合成する。 */
  nameKana?: string | null;
  /** 氏名ローマ字 (合成値・後方互換). 分割 (姓/名) が来た時はサーバが合成する。 */
  nameRomaji?: string | null;
  contact?: string | null;
  desiredTeamId?: string | null;
}

/** The signed-in user's OWN 参加届 (self-service, session-scoped — no target id). The
 *  self-editable slice a 運営 member manages from アカウント設定 → 参加情報. Every field is
 *  nullable so an unfilled 届 reads as all-null; `SelfParticipationUpdateRequest` patches
 *  a subset. Backed by the caller's linked member_people row (resolved via identity link)
 *  — see member-service getSelfParticipation / updateSelfParticipation. Distinct from the
 *  admin `SubmitParticipationRequest` (which targets the review pipeline). */
export type SelfParticipation = PersonProfile;
/** Patch body for the self 参加届 (any subset of the fields). */
export type SelfParticipationUpdateRequest = Partial<SelfParticipation>;

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
