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
  };
}

// ── 表示するカレンダー filter ────────────────────────────────────────────────

export const MEETING_FILTER_STORAGE_KEY = "dub:calendar:meeting-targets";

/** Default ON = 全体 + the targets the caller belongs to. */
export function defaultVisibleTargets(targets: readonly meeting.MeetingTarget[]): string[] {
  return targets.filter((t) => t.id === meeting.ALL_MEMBERS_TARGET_ID || t.isMine).map((t) => t.id);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved choice, or the defaults when nothing (valid) is saved. */
export function loadVisibleTargets(targets: readonly meeting.MeetingTarget[], store: StorageLike | null = storage()): string[] {
  try {
    const raw = store?.getItem(MEETING_FILTER_STORAGE_KEY);
    if (raw) {
      const ids: unknown = JSON.parse(raw);
      if (Array.isArray(ids) && ids.every((x) => typeof x === "string")) return ids as string[];
    }
  } catch {
    // corrupt value: fall back to defaults
  }
  return defaultVisibleTargets(targets);
}

export function saveVisibleTargets(ids: readonly string[], store: StorageLike | null = storage()): void {
  try {
    store?.setItem(MEETING_FILTER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}
