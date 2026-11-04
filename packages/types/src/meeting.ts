// meeting — カレンダー > ミーティング (drive-share-service, gateway segment /meetings).
// Meetings are created on the shared Google account connected in Drive共有 > 設定: each
// target (a role, or "全体" = every active member) owns one Google calendar on that account,
// every meeting is an event on its target's calendar with a Meet link, and the target's
// members are kept invited (reconciled when membership changes).
import type { ISODate, ISODateTime, UserId } from "./common";

/** The pseudo target meaning "every active member" (its calendar is named 全体). */
export const ALL_MEMBERS_TARGET_ID = "all";

/**
 *  none            単発
 *  weekly          毎週 (same weekday)
 *  biweekly        隔週
 *  monthly_weekday 毎月 第N X曜日 (N taken from the first occurrence; 5th => last)
 */
export type MeetingRecurrence = "none" | "weekly" | "biweekly" | "monthly_weekday";
export const MEETING_RECURRENCES: readonly MeetingRecurrence[] = ["none", "weekly", "biweekly", "monthly_weekday"];

/** Meetings are always scheduled in Japan time. */
export const MEETING_TIME_ZONE = "Asia/Tokyo";

export interface Meeting {
  id: string;
  title: string;
  description: string | null;
  /** roleId, or ALL_MEMBERS_TARGET_ID. */
  targetId: string;
  /** Role name, or "全体". */
  targetName: string;
  /** First occurrence start (UTC ISO). */
  startsAt: ISODateTime;
  durationMinutes: number;
  recurrence: MeetingRecurrence;
  /** Last day a recurring meeting may occur (inclusive, JST date). null = no end. */
  until: ISODate | null;
  meetUrl: string | null;
  /** The event in Google Calendar. */
  htmlLink: string | null;
  /** Members currently invited. */
  attendeeCount: number;
  /** 定例: joining from Dub records attendance (全体定例 when targetId is "all", else チーム定例). */
  trackAttendance: boolean;
  createdBy: UserId;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface MeetingTarget {
  /** roleId, or ALL_MEMBERS_TARGET_ID. */
  id: string;
  name: string;
  memberCount: number;
  /** The caller belongs to it (the calendar's default-on filter in Dub). */
  isMine: boolean;
}

/** A member who could not be invited with a Google account (no Gmail on their 名簿 row);
 *  they are invited at their Dub address instead. */
export interface MemberWithoutGoogleAccount {
  userId: UserId;
  name: string;
  email: string;
}

export interface MeetingAccountState {
  /** The Google account meetings are created as (Drive共有 > 設定). null = none connected. */
  email: string | null;
  /** false = the account was connected before calendar access was requested: reconnect it. */
  calendarReady: boolean;
}

export interface ListMeetingsResponse {
  items: Meeting[];
  account: MeetingAccountState;
}

export interface ListMeetingTargetsResponse {
  items: MeetingTarget[];
}

export interface CreateMeetingRequest {
  title: string;
  description?: string | null;
  targetId: string;
  startsAt: ISODateTime;
  durationMinutes: number;
  recurrence: MeetingRecurrence;
  until?: ISODate | null;
  /** 定例として出席を取る (default false). */
  trackAttendance?: boolean;
}

export type UpdateMeetingRequest = Partial<CreateMeetingRequest>;

export interface SyncMeetingsResponse {
  syncedAt: ISODateTime;
  meetings: number;
  invitedAdded: number;
  invitedRemoved: number;
  withoutGoogleAccount: MemberWithoutGoogleAccount[];
}

// ---- 定例の出席 (attendance of 全体定例 / チーム定例) ----
// A meeting with trackAttendance is a 定例. A member who opens its Meet from Dub during an
// occurrence (POST /meetings/:id/join) is recorded present for that occurrence; 人事 sees the
// report (GET /meetings/attendance) and can correct it (PUT .../attendance/:date/:userId).
// Expected members = the target's CURRENT active members (role membership is not historised).

/** all_hands = 全体定例 (target "all"); team = チーム定例 (target is a role). */
export type RegularMeetingKind = "all_hands" | "team";

export function regularKindOf(targetId: string): RegularMeetingKind {
  return targetId === ALL_MEMBERS_TARGET_ID ? "all_hands" : "team";
}

export const REGULAR_KIND_LABELS: Record<RegularMeetingKind, string> = { all_hands: "全体定例", team: "チーム定例" };

/** present = 出席; excused = 欠席連絡あり (rate excludes it from the denominator). No row = 欠席. */
export type AttendanceStatus = "present" | "excused";
export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ["present", "excused"];
/** join = opened the Meet from Dub; manual = set by 人事. */
export type AttendanceSource = "join" | "manual";

/** Joining from Dub counts from this many minutes before an occurrence starts until it ends. */
export const JOIN_WINDOW_BEFORE_MINUTES = 30;

const JST_OFFSET_MS = 9 * 3_600_000;
const MS_PER_DAY = 86_400_000;
const MAX_OCCURRENCES = 400;

function dayMs(key: ISODate): number {
  return Date.parse(`${key}T00:00:00Z`);
}
function keyOf(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}
/** The date of the n-th `weekday` of a month (n>=5 = the last one); month 0-based. */
function nthWeekday(year: number, month: number, weekday: number, n: number): ISODate {
  if (n >= 5) {
    const last = Date.UTC(year, month + 1, 0);
    return keyOf(last - ((new Date(last).getUTCDay() - weekday + 7) % 7) * MS_PER_DAY);
  }
  const first = Date.UTC(year, month, 1);
  return keyOf(first + (((weekday - new Date(first).getUTCDay() + 7) % 7) + (n - 1) * 7) * MS_PER_DAY);
}

export interface OccurrenceStart {
  /** JST date of the occurrence. */
  date: ISODate;
  /** UTC ISO start. */
  startsAt: ISODateTime;
}

/**
 * Every occurrence whose JST date is within [fromKey, toKey] (inclusive), honouring `until`.
 * The same rule the server writes as RRULE (meeting-rules toRecurrence); Google-side edits of
 * single instances are not represented. Shared by the SPA calendar and the attendance service.
 */
export function occurrenceStarts(
  m: Pick<Meeting, "startsAt" | "recurrence" | "until">,
  fromKey: ISODate,
  toKey: ISODate,
): OccurrenceStart[] {
  const firstMs = Date.parse(m.startsAt);
  if (Number.isNaN(firstMs)) return [];
  const firstLocal = new Date(firstMs + JST_OFFSET_MS);
  const firstDate = firstLocal.toISOString().slice(0, 10);
  const lastKey = m.recurrence !== "none" && m.until && m.until < toKey ? m.until : toKey;
  const out: OccurrenceStart[] = [];
  const push = (key: ISODate) => {
    if (key < fromKey || key > lastKey || key < firstDate) return;
    const offsetDays = Math.round((dayMs(key) - dayMs(firstDate)) / MS_PER_DAY);
    out.push({ date: key, startsAt: new Date(firstMs + offsetDays * MS_PER_DAY).toISOString() });
  };
  if (m.recurrence === "weekly" || m.recurrence === "biweekly") {
    const step = m.recurrence === "weekly" ? 7 : 14;
    const gap = Math.round((dayMs(fromKey) - dayMs(firstDate)) / MS_PER_DAY);
    let k = gap > 0 ? Math.ceil(gap / step) : 0;
    for (let i = 0; i < MAX_OCCURRENCES; i++, k++) {
      const key = keyOf(dayMs(firstDate) + k * step * MS_PER_DAY);
      if (key > lastKey) break;
      push(key);
    }
  } else if (m.recurrence === "monthly_weekday") {
    const n = Math.ceil(firstLocal.getUTCDate() / 7);
    const from = new Date(dayMs(fromKey < firstDate ? firstDate : fromKey));
    let y = from.getUTCFullYear();
    let mo = from.getUTCMonth();
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const key = nthWeekday(y, mo, firstLocal.getUTCDay(), n);
      if (key.slice(0, 7) > lastKey.slice(0, 7)) break;
      push(key);
      if (++mo > 11) {
        mo = 0;
        y += 1;
      }
    }
  } else {
    push(firstDate);
  }
  return out;
}

export interface AttendanceRecord {
  userId: UserId;
  status: AttendanceStatus;
  source: AttendanceSource;
  /** First join from Dub (null for a manual record that never joined). */
  joinedAt: ISODateTime | null;
  recordedBy: UserId;
  updatedAt: ISODateTime;
}

export interface AttendanceOccurrence {
  date: ISODate;
  startsAt: ISODateTime;
  records: AttendanceRecord[];
}

export interface AttendanceMeeting {
  id: string;
  title: string;
  targetId: string;
  targetName: string;
  kind: RegularMeetingKind;
  durationMinutes: number;
  recurrence: MeetingRecurrence;
  /** The target's current active members. */
  expectedUserIds: UserId[];
  /** Occurrences in the range that have started, newest first. */
  occurrences: AttendanceOccurrence[];
}

export interface AttendanceMember {
  userId: UserId;
  name: string;
  email: string;
  /** Occurrences this member was expected at (in the range). */
  expected: number;
  present: number;
  excused: number;
  /** present / (expected - excused), 0–1; null when nothing counts. */
  rate: number | null;
}

/** GET /meetings/attendance?from=&to= (JST dates; default: the last 12 weeks up to today). */
export interface AttendanceReportResponse {
  from: ISODate;
  to: ISODate;
  meetings: AttendanceMeeting[];
  /** Every member expected at any 定例, by rate ascending (lowest attendance first). */
  members: AttendanceMember[];
}

/** PUT /meetings/:id/attendance/:date/:userId — null clears the record (= 欠席). */
export interface SetAttendanceRequest {
  status: AttendanceStatus | null;
}

export interface SetAttendanceResponse {
  record: AttendanceRecord | null;
}

/** POST /meetings/:id/join — the caller opens the Meet from Dub. */
export interface JoinMeetingResponse {
  meetUrl: string | null;
  /** The occurrence the join counted for; null = not a 定例 or outside every occurrence window. */
  recordedFor: ISODate | null;
}

/** One 定例 of the caller, for the dashboard's 「定例に参加」 card. */
export interface MyRegularMeeting {
  id: string;
  title: string;
  targetName: string;
  kind: RegularMeetingKind;
  meetUrl: string | null;
  /** The occurrence open for joining now (window), else the next one; null = none left. */
  next: OccurrenceStart | null;
  durationMinutes: number;
  /** Joining now would be recorded. */
  joinOpen: boolean;
  /** Already recorded present for `next`. */
  attended: boolean;
}

/** GET /meetings/me/regulars */
export interface ListMyRegularMeetingsResponse {
  items: MyRegularMeeting[];
}
