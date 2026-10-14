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
}

export type UpdateMeetingRequest = Partial<CreateMeetingRequest>;

export interface SyncMeetingsResponse {
  syncedAt: ISODateTime;
  meetings: number;
  invitedAdded: number;
  invitedRemoved: number;
  withoutGoogleAccount: MemberWithoutGoogleAccount[];
}
