// Pure rules for カレンダー > ミーティング: request validation and recurrence -> RRULE. Meetings are
// always in Japan time (UTC+9, no DST), so JST calendar fields are derived by a fixed offset.
import { errors } from "@dub/errors";
import { meeting } from "@dub/types";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const DURATION_MIN = 5;
export const DURATION_MAX = 720;

/** The validated, normalised shape every write works on. */
export interface MeetingFields {
  title: string;
  description: string | null;
  targetId: string;
  /** UTC ISO (toISOString). */
  startsAt: string;
  durationMinutes: number;
  recurrence: meeting.MeetingRecurrence;
  /** JST date (YYYY-MM-DD), always null for a one-off. */
  until: string | null;
}

/** JST calendar date (YYYY-MM-DD) of an instant. */
export function jstDate(iso: string): string {
  return new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** RRULE lines for Google's `recurrence` ([] for a one-off). UNTIL is the last instant of the
 *  JST `until` day, in UTC as RFC 5545 requires when DTSTART carries a time zone. */
export function toRecurrence(f: Pick<MeetingFields, "startsAt" | "recurrence" | "until">): string[] {
  if (f.recurrence === "none") return [];
  const parts: string[] = [];
  if (f.recurrence === "weekly") parts.push("FREQ=WEEKLY");
  else if (f.recurrence === "biweekly") parts.push("FREQ=WEEKLY", "INTERVAL=2");
  else {
    // 毎月 第N X曜日, N and X from the first occurrence in JST. A 5th X has no counterpart in
    // most months, so it means "the last X" (-1).
    const local = new Date(Date.parse(f.startsAt) + JST_OFFSET_MS);
    const n = Math.ceil(local.getUTCDate() / 7);
    parts.push("FREQ=MONTHLY", `BYDAY=${n >= 5 ? -1 : n}${BYDAY[local.getUTCDay()]}`);
  }
  if (f.until) {
    const lastInstant = new Date(Date.parse(`${f.until}T23:59:59+09:00`));
    parts.push(`UNTIL=${lastInstant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
  }
  return [`RRULE:${parts.join(";")}`];
}

/** The inverse of toRecurrence for an event's current rule (possibly edited in Google Calendar);
 *  null when it is not a shape Dub can represent (the stored one is kept). */
export function fromRecurrence(lines: readonly string[]): Pick<MeetingFields, "recurrence" | "until"> | null {
  const rules = lines.filter((l) => l.startsWith("RRULE:"));
  if (lines.length === 0) return { recurrence: "none", until: null };
  if (rules.length !== 1 || rules.length !== lines.length) return null;
  const p = new Map(rules[0]!.slice(6).split(";").map((kv) => kv.split("=") as [string, string]));
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "UNTIL", "WKST"]);
  if ([...p.keys()].some((k) => !allowed.has(k))) return null;
  let recurrence: meeting.MeetingRecurrence;
  const interval = p.get("INTERVAL") ?? "1";
  if (p.get("FREQ") === "WEEKLY" && (interval === "1" || interval === "2") && (!p.has("BYDAY") || !p.get("BYDAY")!.includes(","))) {
    recurrence = interval === "1" ? "weekly" : "biweekly";
  } else if (p.get("FREQ") === "MONTHLY" && interval === "1" && /^-?\d[A-Z]{2}$/.test(p.get("BYDAY") ?? "")) {
    recurrence = "monthly_weekday";
  } else {
    return null;
  }
  const u = p.get("UNTIL");
  if (!u) return { recurrence, until: null };
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(u);
  if (!m) return null;
  const instant = m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : `${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`;
  return { recurrence, until: jstDate(instant) };
}

/** End instant of the first occurrence. */
export function endsAt(f: Pick<MeetingFields, "startsAt" | "durationMinutes">): string {
  return new Date(Date.parse(f.startsAt) + f.durationMinutes * 60_000).toISOString();
}

type Input = Partial<meeting.CreateMeetingRequest>;

/**
 * Validate a create body, or an update body merged over the stored fields (`base`). Role
 * existence is checked by the caller (needs identity); here targetId must merely be a non-empty
 * string. Messages are Japanese, shown as-is by the SPA.
 */
export function validateMeeting(body: unknown, base?: MeetingFields): MeetingFields {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
  const b = body as Input;
  const pick = <K extends keyof Input>(k: K): Input[K] | undefined => (k in b ? b[k] : base?.[k as keyof MeetingFields] as Input[K]);

  const title = pick("title");
  if (typeof title !== "string" || title.trim().length === 0 || title.trim().length > TITLE_MAX) {
    throw errors.validationFailed([{ field: "title", reason: "invalid" }], `タイトルは 1〜${TITLE_MAX} 文字で入力してください。`);
  }

  const rawDescription = pick("description");
  if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== "string") {
    throw errors.validationFailed([{ field: "description", reason: "invalid" }], "説明の形式が正しくありません。");
  }
  const description = typeof rawDescription === "string" && rawDescription.trim().length > 0 ? rawDescription.trim() : null;
  if (description && description.length > DESCRIPTION_MAX) {
    throw errors.validationFailed([{ field: "description", reason: "too_long" }], `説明は ${DESCRIPTION_MAX} 文字以内で入力してください。`);
  }

  const targetId = pick("targetId");
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw errors.validationFailed([{ field: "targetId", reason: "required" }], "対象（ロールまたは全体）を選んでください。");
  }

  const startsAtRaw = pick("startsAt");
  const startMs = typeof startsAtRaw === "string" ? Date.parse(startsAtRaw) : NaN;
  if (Number.isNaN(startMs)) {
    throw errors.validationFailed([{ field: "startsAt", reason: "invalid" }], "開始日時が正しくありません。");
  }
  const startsAt = new Date(startMs).toISOString();

  const durationMinutes = pick("durationMinutes");
  if (typeof durationMinutes !== "number" || !Number.isInteger(durationMinutes) || durationMinutes < DURATION_MIN || durationMinutes > DURATION_MAX) {
    throw errors.validationFailed(
      [{ field: "durationMinutes", reason: "out_of_range" }],
      `所要時間は ${DURATION_MIN}〜${DURATION_MAX} 分で指定してください。`,
    );
  }

  const recurrence = pick("recurrence");
  if (typeof recurrence !== "string" || !meeting.MEETING_RECURRENCES.includes(recurrence as meeting.MeetingRecurrence)) {
    throw errors.validationFailed([{ field: "recurrence", reason: "invalid" }], "繰り返しの指定が正しくありません。");
  }

  const untilRaw = pick("until");
  let until: string | null = null;
  if (recurrence !== "none" && untilRaw !== undefined && untilRaw !== null && untilRaw !== "") {
    if (typeof untilRaw !== "string" || !isIsoDate(untilRaw)) {
      throw errors.validationFailed([{ field: "until", reason: "invalid" }], "終了日の形式が正しくありません（YYYY-MM-DD）。");
    }
    if (untilRaw < jstDate(startsAt)) {
      throw errors.validationFailed([{ field: "until", reason: "before_start" }], "終了日は初回の日付以降にしてください。");
    }
    until = untilRaw;
  }

  return {
    title: title.trim(),
    description,
    targetId,
    startsAt,
    durationMinutes,
    recurrence: recurrence as meeting.MeetingRecurrence,
    until,
  };
}
