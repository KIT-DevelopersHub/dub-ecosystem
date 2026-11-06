// sponsor — スポンサーアプリ (スポンサーチーム向け) の wire 契約。
// 名刺: カメラで撮った名刺の写真と連絡先を登録し、権限のあるメンバー全員で共有する。
// 営業進捗: 声をかけた企業ごとのステータス・担当・次回アクションを表で管理する (旧 スプレッドシート)。
// 実装は member-service の /members/sponsor/* (D1 `member` namespace + R2 の写真)。
import type { ISODateTime, UserId } from "./common";

/** 写真として受け付ける形式 (端末側で JPEG に縮小してから送る)。 */
export const CARD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type CardImageType = (typeof CARD_IMAGE_TYPES)[number];

/** 写真 1 枚の上限 (端末で縮小した後のサイズ)。 */
export const CARD_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** テキスト項目の最大長 (メモ以外)。 */
export const CARD_FIELD_MAX = 200;
export const CARD_NOTE_MAX = 2000;

export function isCardImageType(v: unknown): v is CardImageType {
  return typeof v === "string" && (CARD_IMAGE_TYPES as readonly string[]).includes(v);
}

/** 名刺 1 枚。写真だけでも登録できるよう、テキスト項目はすべて任意。 */
export interface BusinessCard {
  id: string;
  companyName: string | null;
  personName: string | null;
  department: string | null;
  /** 役職。 */
  title: string | null;
  email: string | null;
  phone: string | null;
  /** 受け取った場面や共有したいこと (例: 〇〇展示会で名刺交換・協賛に前向き)。 */
  note: string | null;
  /** 写真があるか。写真本体は GET /members/sponsor/cards/:id/image。 */
  hasImage: boolean;
  version: number;
  /** 登録したメンバー (identity user id) と、その時点の表示名。 */
  createdBy: UserId;
  createdByName: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ListCardsResponse {
  cards: BusinessCard[];
}

export interface CardFields {
  companyName?: string | null;
  personName?: string | null;
  department?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
}

export type CreateCardRequest = CardFields;

export interface UpdateCardRequest extends CardFields {
  expectedVersion: number;
}

/** 一覧・検索で使う表示名 (会社名 / 氏名が無い名刺は「名刺（未入力）」)。 */
export function cardDisplayName(c: Pick<BusinessCard, "companyName" | "personName">): string {
  const parts = [c.companyName, c.personName].filter((s): s is string => !!s && s.trim() !== "");
  return parts.length > 0 ? parts.join(" / ") : "名刺（未入力）";
}

// ── 営業進捗 ──────────────────────────────────────────────

// 選択肢の値はスプレッドシートの表記そのまま (取り込みと表示で対応表を持たない)。

/** ステータス。見送り以外は左から順に進む。 */
export const LEAD_STATUSES = [
  "未接触", "初回連絡", "返信あり", "提案予定", "提案済", "社内検討", "条件調整", "内諾", "契約済", "見送り",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_PLANS = ["未定", "Title", "Gold", "Silver", "Bronze", "Community Partner", "その他"] as const;
export type LeadPlan = (typeof LEAD_PLANS)[number];

export const LEAD_CONFIDENCES = ["高", "中", "低"] as const;
export type LeadConfidence = (typeof LEAD_CONFIDENCES)[number];

export const LEAD_PRIORITIES = ["S", "A", "B", "C"] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];

/** 取り込み 1 回の上限 (スプレッドシートの管理範囲と同じ)。 */
export const LEAD_IMPORT_MAX = 500;

/** 想定協賛額 (円) の上限。 */
export const LEAD_AMOUNT_MAX = 1_000_000_000_000;

/** 企業名以外はすべて任意。日付は YYYY-MM-DD。 */
export interface LeadFields {
  companyName: string;
  /** 業界。選択肢に収まらない値が実データにあるので自由入力。 */
  industry: string | null;
  /** 営業担当 (こちら側)。 */
  owner: string | null;
  /** 企業側の担当者。 */
  contactName: string | null;
  contactRole: string | null;
  /** 担当者メール。「a／b（CC）」のように複数書けるよう形式は問わない。 */
  contactEmail: string | null;
  /** 接点・紹介元。 */
  source: string | null;
  /** 接点区分。 */
  contactType: string | null;
  /** 根拠・確認日。 */
  evidence: string | null;
  /** 連絡優先度。 */
  priority: LeadPriority | null;
  plan: LeadPlan | null;
  status: LeadStatus;
  firstContactOn: string | null;
  lastContactOn: string | null;
  /** 提案日・内諾日。ステータスが進んだ時に自動で入る (手で直せる)。月間目標の実績の基準。 */
  proposedOn: string | null;
  agreedOn: string | null;
  nextAction: string | null;
  nextActionOn: string | null;
  /** 想定協賛額 (円)。 */
  expectedAmount: number | null;
  confidence: LeadConfidence | null;
  budgetPeriod: string | null;
  decisionPeriod: string | null;
  note: string | null;
}

/** 営業先 1 社 (スプレッドシートの 1 行)。 */
export interface SponsorLead extends LeadFields {
  id: string;
  version: number;
  createdBy: UserId;
  createdByName: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ListLeadsResponse {
  leads: SponsorLead[];
}

/** 省略した項目は空 (status は「未接触」)。 */
export type CreateLeadRequest = Pick<LeadFields, "companyName"> & Partial<Omit<LeadFields, "companyName">>;

export interface UpdateLeadRequest extends Partial<LeadFields> {
  expectedVersion: number;
}

export interface ImportLeadsRequest {
  leads: CreateLeadRequest[];
}

export interface ImportLeadsResponse {
  /** 追加された行。 */
  leads: SponsorLead[];
  /** 登録済みの企業 (companyKey が同じ) なので飛ばした行数。 */
  skipped: number;
}

/** 進み具合 (見送りは最下位)。 */
export function leadStatusRank(s: LeadStatus): number {
  return s === "見送り" ? -1 : LEAD_STATUSES.indexOf(s);
}

/** 日本時間の暦日 (YYYY-MM-DD)。 */
export function jstDate(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** そのステータスに達した日を持つ項目。 */
export const LEAD_MILESTONES = [
  { field: "firstContactOn", reachedAt: "初回連絡" },
  { field: "proposedOn", reachedAt: "提案済" },
  { field: "agreedOn", reachedAt: "内諾" },
] as const;

/**
 * ステータスの変更に合わせて節目の日付を埋める。進んだら今日を入れ (既に日付があれば残す)、節目より手前へ戻したら消す。
 * 見送りにする時は過去の節目を残し、見送りから戻す時は戻した先より後の節目を消す。explicit = 今回の更新で手入力された項目 (触らない)。
 */
export function applyLeadMilestones<T extends Pick<LeadFields, "status" | "firstContactOn" | "proposedOn" | "agreedOn">>(
  prevStatus: LeadStatus,
  next: T,
  explicit: readonly string[],
  today: string,
): T {
  if (next.status === "見送り" || next.status === prevStatus) return next;
  const out = { ...next };
  for (const { field, reachedAt } of LEAD_MILESTONES) {
    if (explicit.includes(field)) continue;
    const reached = leadStatusRank(next.status) >= leadStatusRank(reachedAt);
    const wasReached = leadStatusRank(prevStatus) >= leadStatusRank(reachedAt);
    if (reached && !wasReached) out[field] ??= today;
    if (!reached && (wasReached || prevStatus === "見送り")) out[field] = null;
  }
  return out;
}

// ── 月間目標 ──────────────────────────────────────────────

/** 目標を置く指標。金額だけ円、ほかは社数。 */
export const GOAL_METRICS = ["contacted", "proposed", "agreed", "amount"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

export type GoalTargets = Record<GoalMetric, number | null>;

/** 1 か月の目標。null = その指標は目標なし。 */
export interface MonthlyGoal extends GoalTargets {
  /** YYYY-MM。 */
  month: string;
  version: number;
  updatedBy: UserId;
  updatedByName: string | null;
  updatedAt: ISODateTime;
}

export interface ListGoalsResponse {
  goals: MonthlyGoal[];
}

export interface PutGoalRequest extends GoalTargets {
  /** 新規は 0。 */
  expectedVersion: number;
}

const LEGAL_FORMS =
  /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|npo法人|\((株|有|同|資|名|社|財)\)/g;

/** 会社名の照合キー。法人格・空白・記号を除いた NFKC 小文字。 */
export function companyKey(name: string): string {
  const base = name.normalize("NFKC").toLowerCase();
  const key = base.replace(LEGAL_FORMS, "").replace(/[\s・.,、。'"]/g, "");
  return key === "" ? base.trim() : key;
}
