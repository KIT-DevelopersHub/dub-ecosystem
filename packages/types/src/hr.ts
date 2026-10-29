// hr — 人事アプリ (面談 → 採用 → オンボーディング) の wire 契約。
// 実装は member-service の /members/hr/* (名簿と同じ D1 `member` namespace)。名簿そのもの
// (member_people) は複製しない: 採用した応募者は member.Member として名簿に入り、
// オンボーディングは既存の案内項目 (member.OnboardingItem) をチェックリストとして読む。
import type { ISODateTime, UserId } from "./common";

/**
 * 応募者のステータス (人事の運用どおり・この順で表示)。
 *   面談日程調整中 → 面談確定 → 面談済み → 採用 / 不採用 → オンボーディング調整 → オンボーディング完了
 *   辞退 はどこからでも。
 */
export const APPLICANT_STAGES = [
  "scheduling", // 面談日程調整中
  "interview_set", // 面談確定
  "interviewed", // 面談済み
  "hired", // 採用 (名簿に追加済み)
  "rejected", // 不採用
  "onboarding", // オンボーディング調整
  "onboarded", // オンボーディング完了
  "withdrawn", // 辞退
] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number];

export const APPLICANT_STAGE_LABELS: Record<ApplicantStage, string> = {
  scheduling: "面談日程調整中",
  interview_set: "面談確定",
  interviewed: "面談済み",
  hired: "採用",
  rejected: "不採用",
  onboarding: "オンボーディング調整",
  onboarded: "オンボーディング完了",
  withdrawn: "辞退",
};

/** 名簿 (member_people) に結ばれていることが前提のステータス。 */
export const ROSTER_STAGES: readonly ApplicantStage[] = ["hired", "onboarding", "onboarded"];

/** 「オンボーディング前」フィルタ = 採用済みでオンボーディングが終わっていない人。 */
export const BEFORE_ONBOARDING_STAGES: readonly ApplicantStage[] = ["hired", "onboarding"];

export function isApplicantStage(v: unknown): v is ApplicantStage {
  return typeof v === "string" && (APPLICANT_STAGES as readonly string[]).includes(v);
}

/**
 * ステータス変更 (POST /stage) の可否。人事が誤操作を直せるよう寛容にしてあり、前のステータスへ
 * 戻すことも含めてどこからどこへでも動かせる。例外は 1 つだけ:
 *   採用 / オンボーディング調整 / オンボーディング完了 は名簿に結ばれている人だけ。まだ名簿に
 *   いない人を採用にするのは POST /join (確認ダイアログ → 名簿に追加) 専用で、黙って追加しない。
 */
export function canTransition(from: ApplicantStage, to: ApplicantStage, hasMember: boolean): boolean {
  if (from === to) return false;
  return hasMember || !ROSTER_STAGES.includes(to);
}

/** 採用 (POST /join) が必要か = 名簿にいない人を名簿前提のステータスにしようとしている。 */
export function requiresJoin(to: ApplicantStage, hasMember: boolean): boolean {
  return !hasMember && ROSTER_STAGES.includes(to);
}

export interface Applicant {
  id: string;
  name: string;
  nameKana: string | null;
  email: string | null;
  department: string | null;
  grade: string | null;
  /** 希望チーム (member_teams.id)。 */
  desiredTeamId: string | null;
  /** 応募経路 (例: 公開フォーム / 紹介 / イベント)。自由記述。 */
  source: string | null;
  motivation: string | null;
  /** 面談日時 (任意)。 */
  interviewAt: ISODateTime | null;
  stage: ApplicantStage;
  /** 参加確定後の名簿行 (member_people.id)。 */
  memberId: string | null;
  /** 元になった参加届 (member_participations.id) があれば。 */
  participationId: string | null;
  version: number;
  createdBy: UserId;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ApplicantEventKind = "created" | "stage" | "note" | "joined";

/** 応募者の履歴 (段階変更・メモ・参加確定)。追記のみ。 */
export interface ApplicantEvent {
  id: string;
  applicantId: string;
  kind: ApplicantEventKind;
  fromStage: ApplicantStage | null;
  toStage: ApplicantStage | null;
  body: string | null;
  actorId: UserId;
  createdAt: ISODateTime;
}

/** 一覧の 1 行 = 応募者 + 最新のメモ/履歴の抜粋 (表の「メモ」列)。 */
export interface ApplicantListItem extends Applicant {
  latestNote: string | null;
}

export interface ListApplicantsResponse {
  applicants: ApplicantListItem[];
}

export interface ApplicantDetail {
  applicant: Applicant;
  events: ApplicantEvent[];
}

export interface CreateApplicantRequest {
  name: string;
  nameKana?: string | null;
  email?: string | null;
  department?: string | null;
  grade?: string | null;
  desiredTeamId?: string | null;
  source?: string | null;
  motivation?: string | null;
  interviewAt?: ISODateTime | null;
  participationId?: string | null;
}

export interface UpdateApplicantRequest extends Partial<CreateApplicantRequest> {
  expectedVersion: number;
}

export interface MoveApplicantStageRequest {
  stage: ApplicantStage;
  expectedVersion: number;
  /** 任意の理由メモ (履歴に残る)。 */
  note?: string | null;
}

export interface AddApplicantNoteRequest {
  body: string;
}

/**
 * 採用 (名簿に追加)。memberId を渡すと既存の名簿行に紐付け (招待中の人など)、省略すると応募内容から
 * 在籍 (added) の名簿行を新規作成する。いずれも名簿 (member_people) が唯一の実体。
 */
export interface JoinApplicantRequest {
  expectedVersion: number;
  memberId?: string | null;
}

export interface JoinApplicantResponse {
  applicant: Applicant;
  memberId: string;
}

/**
 * オンボーディング: 1 新メンバー分のチェック状況。項目は member.OnboardingItem を流用。
 * チェックを付けると 採用 → オンボーディング調整、全部付くと → オンボーディング完了 に自動で進む
 * (外すと オンボーディング調整 に戻る)。オンボーディング完了は手動でも選べる。
 */
export interface OnboardingProgress {
  memberId: string;
  name: string;
  applicantId: string | null;
  /** 応募者のステータス (オンボーディング調整 / オンボーディング完了 など)。人事経由でなければ null。 */
  stage: ApplicantStage | null;
  joinedAt: ISODateTime | null;
  /** チェック済みの案内項目 id。 */
  checkedItemIds: string[];
  total: number;
  done: number;
  completed: boolean;
}

export interface ListOnboardingProgressResponse {
  items: Array<{ id: string; title: string; description: string | null; url: string | null }>;
  members: OnboardingProgress[];
}

export interface SetOnboardingCheckRequest {
  checked: boolean;
}
