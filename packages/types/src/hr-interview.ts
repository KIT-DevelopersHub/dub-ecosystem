// 人事: 面談の日程調整。人事が登録した面談枠から、応募者がメールの URL で日程を選ぶ。
// 申し込み時点では日程を聞かず、自動返信メールの URL で選んでもらう。枠が足りない間はメールを保留する。
import type { ISODateTime, UserId } from "./common";

/** 公開の日程選択ページ。トークンは URL の fragment (#t=...) に載せ、サーバーログに残さない。 */
export const PUBLIC_INTERVIEW_BOOKING_PATH = "/interview-book";

export const DEFAULT_MIN_OPEN_SLOTS = 5;
export const MIN_OPEN_SLOTS_LIMIT = { min: 1, max: 50 } as const;
export const SLOT_DURATIONS_MINUTES = [30, 45, 60, 90] as const;
export const DEFAULT_SLOT_DURATION_MINUTES = 30;

export interface InterviewSlot {
  id: string;
  startAt: ISODateTime;
  endAt: ISODateTime;
  interviewerId: UserId;
  interviewerName: string;
  applicantId: string | null;
  /** 予約した応募者の氏名。予約が無い、または応募者が削除済みなら null。 */
  applicantName: string | null;
  bookedAt: ISODateTime | null;
}

/** held = 枠が足りずメール保留中 / sent = 送信済み・未予約 / booked = 予約済み */
export type InterviewInviteStatus = "held" | "sent" | "booked";

export const INVITE_STATUS_LABELS: Record<InterviewInviteStatus, string> = {
  held: "メール保留中",
  sent: "メール送信済み",
  booked: "予約済み",
};

export interface InterviewInvite {
  id: string;
  applicantId: string;
  applicantName: string;
  email: string | null;
  status: InterviewInviteStatus;
  sentAt: ISODateTime | null;
  /** 最後の送信失敗の理由コード。成功すると null。 */
  lastError: string | null;
  createdAt: ISODateTime;
}

export interface InterviewSettings {
  /** 選べる候補がこの数以上あるときだけ、案内メールを送る。 */
  minOpenSlots: number;
}

export interface InterviewOverview {
  settings: InterviewSettings;
  /** 応募者が今選べる候補の数 (同じ時刻の枠は 1 候補)。 */
  openSlotCount: number;
  heldCount: number;
  slots: InterviewSlot[];
  invites: InterviewInvite[];
}

export interface AddInterviewSlotRequest {
  startAt: ISODateTime;
  durationMinutes: number;
}

export type SaveInterviewSettingsRequest = InterviewSettings;

export interface PublicInterviewSlot {
  id: string;
  startAt: ISODateTime;
  endAt: ISODateTime;
}

/** open = 選べる / booked = 予約済み / closed = 選考が進んだなど、ここでは選べない */
export type PublicBookingState = "open" | "booked" | "closed";

export interface PublicInterviewBooking {
  state: PublicBookingState;
  applicantName: string;
  slots: PublicInterviewSlot[];
  booked: PublicInterviewSlot | null;
}

export interface PublicBookingViewRequest {
  token: string;
}

export interface PublicBookingRequest {
  token: string;
  slotId: string;
}

export function isValidMinOpenSlots(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_OPEN_SLOTS_LIMIT.min && v <= MIN_OPEN_SLOTS_LIMIT.max;
}

/** 応募者に見せる候補。未来の空き枠を時刻ごとに 1 件へまとめ、早い順に並べる (担当者は見せない)。 */
export function publicSlots(
  slots: readonly Pick<InterviewSlot, "id" | "startAt" | "endAt" | "applicantId">[],
  now: ISODateTime,
): PublicInterviewSlot[] {
  const byTime = new Map<string, PublicInterviewSlot>();
  const nowMs = Date.parse(now);
  for (const s of slots) {
    if (s.applicantId !== null || Date.parse(s.startAt) <= nowMs) continue;
    const key = `${s.startAt}|${s.endAt}`;
    if (!byTime.has(key)) byTime.set(key, { id: s.id, startAt: s.startAt, endAt: s.endAt });
  }
  return [...byTime.values()].sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.endAt < b.endAt ? -1 : 1));
}

const JST = "Asia/Tokyo";
const DAY_FORMAT = new Intl.DateTimeFormat("ja-JP", { timeZone: JST, month: "long", day: "numeric", weekday: "short" });
const TIME_FORMAT = new Intl.DateTimeFormat("ja-JP", { timeZone: JST, hour: "2-digit", minute: "2-digit", hour12: false });

/** 例: 11月10日(火) 14:00〜14:30 (メールと画面で同じ表記・常に日本時間)。 */
export function formatSlotJst(slot: { startAt: string; endAt: string }): string {
  const start = new Date(slot.startAt);
  const day = DAY_FORMAT.format(start).replace(/\s*([日月火水木金土])曜日$/u, "($1)");
  return `${day} ${TIME_FORMAT.format(start)}〜${TIME_FORMAT.format(new Date(slot.endAt))}`;
}

export function bookingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${PUBLIC_INTERVIEW_BOOKING_PATH}#t=${encodeURIComponent(token)}`;
}
