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
  /** Its Google calendar id, only when `isMine` and the calendar exists (first meeting made). Shares
   *  send no mail, so Dub links it as 「Googleカレンダーに追加」. */
  calendarId?: string;
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

/** An invitee's answer in Google Calendar (the event's attendees[].responseStatus). */
export type MeetingResponseStatus = "accepted" | "declined" | "tentative" | "needsAction";
export const MEETING_RESPONSE_LABELS: Record<MeetingResponseStatus, string> = {
  accepted: "参加",
  declined: "不参加",
  tentative: "未定",
  needsAction: "未返信",
};

export interface MeetingAttendee {
  /** The Dub member, null for a guest added by hand in Google Calendar. */
  userId: UserId | null;
  name: string;
  /** Guests only (members are shown by name). */
  email: string | null;
  response: MeetingResponseStatus;
  /** The note left with the answer in Google Calendar. */
  comment: string | null;
}

/** GET /meetings/:id/attendees?date=YYYY-MM-DD — who is invited and their answers. `date` (JST)
 *  picks one occurrence of a series (answers can differ per occurrence); absent = the series. */
export interface ListMeetingAttendeesResponse {
  items: MeetingAttendee[];
  /** false = Google could not be read now (usage limit / account not ready): every answer is needsAction. */
  responsesAvailable: boolean;
}

export interface SyncMeetingsResponse {
  syncedAt: ISODateTime;
  meetings: number;
  invitedAdded: number;
  invitedRemoved: number;
  withoutGoogleAccount: MemberWithoutGoogleAccount[];
}

// ---- 定例の出席 (attendance of 全体定例 / チーム定例) ----
// A meeting with trackAttendance is a 定例. Attendance comes from, strongest first:
//   manual   — 人事 set it by hand (PUT .../attendance/:date/:userId)
//   meet_api — Google Meet's own participant records (conferenceRecords → participants →
//              participantSessions), ingested after each occurrence ends; a participant counts as
//              present when matched to a Dub member and in the meeting at least minPercent of its
//              scheduled length. Matching is by Google account id (users/{id}): a member's own
//              「Googleと連携」 link, or a mapping 人事 confirmed once (remembered).
//   join     — the member opened the Meet from Dub (POST /meetings/:id/join) during the occurrence;
//              counts only when Meet has no matched participant for them.
// Expected members = the target's CURRENT active members (role membership is not historised).

/** all_hands = 全体定例 (target "all"); team = チーム定例 (target is a role). */
export type RegularMeetingKind = "all_hands" | "team";

export function regularKindOf(targetId: string): RegularMeetingKind {
  return targetId === ALL_MEMBERS_TARGET_ID ? "all_hands" : "team";
}

export const REGULAR_KIND_LABELS: Record<RegularMeetingKind, string> = { all_hands: "全体定例", team: "チーム定例" };

/** present = 出席; excused = 欠席連絡あり (rate excludes it from the denominator); absent = 欠席
 *  (set by hand, or Meet shows them for less than the threshold). No record = 欠席. */
export type AttendanceStatus = "present" | "excused" | "absent";
export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ["present", "excused", "absent"];
/** manual = 人事; meet_api = Google Meet participant records; join = opened the Meet from Dub. */
export type AttendanceSource = "manual" | "meet_api" | "join";

/** Default share of the scheduled length a participant must be in the Meet to count as present. */
export const DEFAULT_MIN_ATTEND_PERCENT = 50;

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

/** What Meet recorded for one person in one occurrence (all their conferences / sessions merged). */
export interface MeetPresence {
  firstJoin: ISODateTime;
  /** null = still in the meeting when ingested. */
  lastLeave: ISODateTime | null;
  durationSeconds: number;
  /** true = sessions could not all be read; duration is first join → last leave. */
  approx: boolean;
}

export interface AttendanceRecord {
  userId: UserId;
  status: AttendanceStatus;
  source: AttendanceSource;
  /** Opened the Meet from Dub at (null = never). */
  joinedAt: ISODateTime | null;
  /** Matched Meet participant(s) of this member (null = none). */
  meet: MeetPresence | null;
  /** Who set a manual record (null for automatic ones). */
  recordedBy: UserId | null;
  updatedAt: ISODateTime | null;
}

export type MeetParticipantKind = "signed_in" | "anonymous" | "phone";

/** One Meet participant of an occurrence, matched or not. */
export interface MeetParticipant extends MeetPresence {
  /** Stable within the occurrence: "u:<googleUserId>" for signed-in users, else the participant resource. */
  key: string;
  kind: MeetParticipantKind;
  displayName: string;
  /** Google account id (the {id} of users/{id}); null for anonymous / phone. */
  googleUserId: string | null;
  /** The Dub member it is matched to (null = 未確定 / guest). */
  userId: UserId | null;
  /** For an unmatched signed-in participant: members whose name looks like displayName, best first. */
  suggestions: { userId: UserId; name: string }[];
}

export type MeetIngestStatus = "done" | "no_conference" | "error";

export interface MeetIngestState {
  status: MeetIngestStatus;
  ingestedAt: ISODateTime;
  error: string | null;
}

export interface AttendanceOccurrence {
  date: ISODate;
  startsAt: ISODateTime;
  /** Effective attendance of every member with any signal (manual / Meet / Dub join). */
  records: AttendanceRecord[];
  /** Everyone Meet recorded (members, 未確定, guests). */
  participants: MeetParticipant[];
  /** null = Meet records not read for this occurrence yet. */
  ingest: MeetIngestState | null;
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

export interface AttendanceSettings {
  /** Present when in the Meet at least this % of the scheduled length (1–100). */
  minPercent: number;
}

export interface MeetApiState {
  /** false = the shared Google account lacks meetings.space.readonly: reconnect it in Drive共有 > 設定. */
  ready: boolean;
  /** Last ingest run (scheduled or manual); null = never. */
  lastRunAt: ISODateTime | null;
}

/** GET /meetings/attendance?from=&to= (JST dates; default: the last 12 weeks up to today). */
export interface AttendanceReportResponse {
  from: ISODate;
  to: ISODate;
  settings: AttendanceSettings;
  meetApi: MeetApiState;
  meetings: AttendanceMeeting[];
  /** Every member expected at any 定例, by rate ascending (lowest attendance first). */
  members: AttendanceMember[];
}

/** PUT /meetings/:id/attendance/:date/:userId — a manual record; null removes it (back to 自動). */
export interface SetAttendanceRequest {
  status: AttendanceStatus | null;
}

export interface SetAttendanceResponse {
  /** The manual record, or null when removed. */
  record: AttendanceRecord | null;
}

/** POST /meetings/attendance/ingest — read Meet records now. Without a range: every occurrence not
 *  read yet (or still settling / failed) within Google's retention (29 days). With a range: re-read it. */
export interface IngestAttendanceRequest {
  from?: ISODate;
  to?: ISODate;
}

export interface IngestAttendanceResponse {
  /** Occurrences read this run. */
  occurrences: number;
  participants: number;
  /** false = stopped at the Google call budget; the scheduled job continues shortly. */
  complete: boolean;
  /** scope_missing = reconnect the shared Google account (Drive共有 > 設定). */
  skipped: "scope_missing" | "no_account" | null;
}

/** PUT /meetings/attendance/links/:googleUserId — 人事 confirms who a Meet participant is (remembered). */
export interface ConfirmParticipantRequest {
  userId: UserId;
}

/** PUT /meetings/attendance/settings */
export type UpdateAttendanceSettingsRequest = AttendanceSettings;

/** POST /meetings/me/google-link/start — 「Googleと連携」 (openid only; stores the Google account id). */
export interface StartGoogleLinkRequest {
  redirectUri: string;
}

export interface StartGoogleLinkResponse {
  authUrl: string;
}

/** POST /meetings/me/google-link/callback */
export interface CompleteGoogleLinkRequest {
  code: string;
  state: string;
}

/** State prefix of a 「Googleと連携」 round-trip (shares the /driveshare return page with the account connect). */
export const GOOGLE_LINK_STATE_PREFIX = "lnk_";

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
  /** The caller linked a Google account (Meet attendance is then automatic). */
  googleLinked: boolean;
}
