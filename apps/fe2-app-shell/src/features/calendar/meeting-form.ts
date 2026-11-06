// Meeting form + 表示するカレンダー filter — pure helpers (validation, request payload,
// filter defaults / persistence). Kept React-free so they are unit-tested directly.
import { meeting } from "@dub/types";
import { jstParts, jstToUtcIso } from "./meeting-occurrences";

export const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120] as const;
export const TITLE_MAX = 100;

export interface MeetingFormValues {
  title: string;
  targetId: string;
  /** "YYYY-MM-DD" JST. */
  date: string;
  /** "HH:MM" JST. */
  time: string;
  durationMinutes: number;
  recurrence: meeting.MeetingRecurrence;
  /** "YYYY-MM-DD" JST or "" (no end). Ignored unless recurring. */
  until: string;
  description: string;
  /** 定例として出席を取る (Dub から参加した人を記録し、人事で確認できる)。 */
  trackAttendance: boolean;
}

export type MeetingFormErrors = Partial<Record<keyof MeetingFormValues, string>>;

/** 15-minute time slots 00:00 … 23:45. */
export const TIME_OPTIONS: string[] = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
});

/** Blank form for a new meeting (target 全体, today's JST date, 21:00, 60 min, 毎週). */
export function emptyMeetingForm(now: Date = new Date()): MeetingFormValues {
  return {
    title: "",
    targetId: meeting.ALL_MEMBERS_TARGET_ID,
    date: jstParts(now.toISOString())?.date ?? "",
    time: "21:00",
    durationMinutes: 60,
    recurrence: "weekly",
    until: "",
    description: "",
    trackAttendance: false,
  };
}

/** A repeating 予定 from the 作成 dialog, carried into the meeting form. A role label that is a
 *  meeting target becomes the target (else 全体); the length snaps to the nearest 所要時間 option. */
export function meetingFormFromDraft(
  d: { title: string; description: string; label: string; startDate: string; startTime: string; endTime: string },
  recurrence: meeting.MeetingRecurrence,
  targets: readonly meeting.MeetingTarget[] = [],
): MeetingFormValues {
  const minutes = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const length = minutes(d.endTime) - minutes(d.startTime);
  const durationMinutes = DURATION_OPTIONS.reduce<number>((best, o) => (Math.abs(o - length) < Math.abs(best - length) ? o : best), DURATION_OPTIONS[0]);
  return {
    ...emptyMeetingForm(),
    ...(targets.some((t) => t.id === d.label) ? { targetId: d.label } : {}),
    title: d.title.trim().slice(0, TITLE_MAX),
    date: d.startDate,
    time: d.startTime,
    durationMinutes,
    recurrence,
    description: d.description,
  };
}

/** Form values for editing an existing meeting. */
export function meetingToForm(m: meeting.Meeting): MeetingFormValues {
  const p = jstParts(m.startsAt);
  return {
    title: m.title,
    targetId: m.targetId,
    date: p?.date ?? "",
    time: p?.time ?? "",
    durationMinutes: m.durationMinutes,
    recurrence: m.recurrence,
    until: m.until ?? "",
    description: m.description ?? "",
    trackAttendance: m.trackAttendance,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export function validateMeetingForm(v: MeetingFormValues): MeetingFormErrors {
  const e: MeetingFormErrors = {};
  const title = v.title.trim();
  if (!title) e.title = "タイトルを入力してください";
  else if (title.length > TITLE_MAX) e.title = `タイトルは${TITLE_MAX}文字以内で入力してください`;
  if (!v.targetId) e.targetId = "対象を選んでください";
  if (!DATE_RE.test(v.date)) e.date = "日付を選んでください";
  if (!TIME_RE.test(v.time)) e.time = "開始時刻を選んでください";
  if (!(DURATION_OPTIONS as readonly number[]).includes(v.durationMinutes)) e.durationMinutes = "所要時間を選んでください";
  if (v.recurrence !== "none" && v.until) {
    if (!DATE_RE.test(v.until)) e.until = "終了日の形式が正しくありません";
    else if (DATE_RE.test(v.date) && v.until < v.date) e.until = "終了日は開始日以降にしてください";
  }
  return e;
}

/** The request body for a valid form (startsAt = UTC ISO of the JST date + time). */
export function toMeetingRequest(v: MeetingFormValues): meeting.CreateMeetingRequest {
  const description = v.description.trim();
  return {
    title: v.title.trim(),
    description: description ? description : null,
    targetId: v.targetId,
    startsAt: jstToUtcIso(v.date, v.time),
    durationMinutes: v.durationMinutes,
    recurrence: v.recurrence,
    until: v.recurrence !== "none" && v.until ? v.until : null,
    trackAttendance: v.trackAttendance,
  };
}

// ── 表示するカレンダー filter ────────────────────────────────────────────────

/** Checkboxes the user ticked / unticked, by target id. Unlisted targets use the default. */
export type MeetingTargetChoices = Readonly<Record<string, boolean>>;

/**
 * Whether meetings of `targetId` are drawn. An explicit choice wins; otherwise 全体 and the
 * caller's own targets are ON. `targets` = null while loading: an unknown default stays OFF
 * so a meeting appears late rather than flashing and vanishing; "error" shows everything.
 * A target missing from the list (deleted role) is ON so its meetings never silently hide.
 * `created` = targets the caller has made meetings for: ON too (a meeting I set up must show).
 */
export function isMeetingTargetVisible(
  targetId: string,
  choices: MeetingTargetChoices,
  targets: readonly meeting.MeetingTarget[] | null | "error",
  created: ReadonlySet<string> = new Set(),
): boolean {
  const chosen = choices[targetId];
  if (chosen !== undefined) return chosen;
  if (targetId === meeting.ALL_MEMBERS_TARGET_ID || targets === "error" || created.has(targetId)) return true;
  if (targets === null) return false;
  return targets.find((t) => t.id === targetId)?.isMine ?? true;
}

export function parseMeetingTargetChoices(v: unknown): MeetingTargetChoices {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
}
