// hr — 人事アプリ (応募 → 選考 → 内定 → 参加 → オンボーディング) の wire 契約。
// 実装は member-service の /members/hr/* (名簿と同じ D1 `member` namespace)。名簿そのもの
// (member_people) は複製しない: 参加確定した応募者は member.Member として名簿に入り、
// オンボーディングは既存の案内項目 (member.OnboardingItem) をチェックリストとして読む。
import type { ISODateTime, UserId } from "./common";

/** 選考パイプラインの段階。terminal = rejected / withdrawn / joined。 */
export const APPLICANT_STAGES = [
  "applied", // 応募
  "screening", // 書類選考
  "interview", // 面談
  "offered", // 内定
  "joined", // 参加 (名簿に追加済み)
  "rejected", // 不採用
  "withdrawn", // 辞退
] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number];

/** パイプライン (カンバン) に並べる進行中の段階。 */
export const PIPELINE_STAGES: readonly ApplicantStage[] = ["applied", "screening", "interview", "offered", "joined"];

export const APPLICANT_STAGE_LABELS: Record<ApplicantStage, string> = {
  applied: "応募",
  screening: "書類選考",
  interview: "面談",
  offered: "内定",
  joined: "参加",
  rejected: "不採用",
  withdrawn: "辞退",
};

/**
 * 許可される段階遷移 (POST /stage)。joined へは /join だけが進める (名簿への追加を伴うため)。
 * joined からは戻せない (名簿側で管理する)。不採用/辞退は応募へ戻して再開できる。
 */
export const STAGE_TRANSITIONS: Record<ApplicantStage, readonly ApplicantStage[]> = {
  applied: ["screening", "interview", "rejected", "withdrawn"],
  screening: ["applied", "interview", "rejected", "withdrawn"],
  interview: ["screening", "offered", "rejected", "withdrawn"],
  offered: ["interview", "rejected", "withdrawn"],
  joined: [],
  rejected: ["applied"],
  withdrawn: ["applied"],
};

export function isApplicantStage(v: unknown): v is ApplicantStage {
  return typeof v === "string" && (APPLICANT_STAGES as readonly string[]).includes(v);
}

export function canTransition(from: ApplicantStage, to: ApplicantStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
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

export interface ListApplicantsResponse {
  applicants: Applicant[];
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
 * 参加確定。memberId を渡すと既存の名簿行に紐付け (招待中の人など)、省略すると応募内容から
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

/** オンボーディング: 1 新メンバー分のチェック状況。項目は member.OnboardingItem を流用。 */
export interface OnboardingProgress {
  memberId: string;
  name: string;
  applicantId: string | null;
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
