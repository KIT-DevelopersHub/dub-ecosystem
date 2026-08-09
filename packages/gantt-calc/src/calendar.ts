// Working-day calendar. Skips weekends + holidays and converts task durations
// expressed in *working days* into concrete calendar-day indices (day-space,
// integer days since UTC epoch — same space as dates.ts). Pure & deterministic:
// no Date.now, all math is integer arithmetic over a fixed epoch reference.
import type { common } from "@dub/types";
import { dayOf } from "./dates";

// Day 0 (1970-01-01, UTC) is a Thursday. dow: 0=Sun .. 6=Sat.
const EPOCH_DOW = 4; // Thursday
const DEFAULT_WEEKEND = [0, 6]; // Sunday, Saturday

/** Day-of-week (0=Sun .. 6=Sat) for a day index, correct for negatives too. */
export function dayOfWeek(day: number): number {
  return (((day + EPOCH_DOW) % 7) + 7) % 7;
}

export interface WorkCalendarOptions {
  /** Non-working weekdays (0=Sun .. 6=Sat). Default: Saturday & Sunday. */
  weekendDays?: number[];
  /** Additional non-working dates (ISO8601 date or datetime); time-of-day ignored. */
  holidays?: (common.ISODate | common.ISODateTime)[];
}

export interface WorkCalendar {
  /** True when `day` is neither a weekend nor a holiday. */
  isWorkingDay(day: number): boolean;
  /** Smallest working day >= `day`. */
  nextWorkingDay(day: number): number;
  /** Working days in the half-open range [startDay, endDay). */
  countWorkingDays(startDay: number, endDay: number): number;
  /** Calendar day reached by moving `workingDays` working days from `startDay`
   *  (the start is first snapped forward to a working day). */
  addWorkingDays(startDay: number, workingDays: number): number;
  /** Calendar day -> working-day ordinal (start-snapping: non-working days map
   *  to the ordinal of the next working day). Inverse of {@link fromOrdinal}. */
  toOrdinal(day: number): number;
  /** Working-day ordinal -> calendar day of that (0-indexed) working day. */
  fromOrdinal(ordinal: number): number;
}

export function createWorkCalendar(options: WorkCalendarOptions = {}): WorkCalendar {
  const weekend = new Set(options.weekendDays ?? DEFAULT_WEEKEND);
  const holidayDays = new Set<number>();
  for (const h of options.holidays ?? []) {
    const d = dayOf(h, "holidays");
    if (!weekend.has(dayOfWeek(d))) holidayDays.add(d); // weekend holidays are redundant
  }

  // Per-week (7-day, aligned to day 0's Thursday) working-day pattern.
  const isWorkDow: boolean[] = [];
  for (let i = 0; i < 7; i++) isWorkDow.push(!weekend.has((EPOCH_DOW + i) % 7));
  const weekPrefix: number[] = [0]; // weekPrefix[k] = working slots in first k of the week
  const workOffsets: number[] = []; // week-relative offsets of working days, ascending
  for (let i = 0; i < 7; i++) {
    if (isWorkDow[i]) workOffsets.push(i);
    weekPrefix.push(weekPrefix[i]! + (isWorkDow[i] ? 1 : 0));
  }
  const perWeek = weekPrefix[7]!; // working days per week (0 only if every day is weekend)

  const isWorkingDay = (day: number): boolean =>
    !weekend.has(dayOfWeek(day)) && !holidayDays.has(day);

  const nextWorkingDay = (day: number): number => {
    let d = day;
    while (!isWorkingDay(d)) d++;
    return d;
  };

  // Signed working-day count of [0, n): working days for n>0, negated for n<0.
  // Arithmetic (Math.floor) is valid for negative n; weekend-holidays excluded above.
  const workingDaysUpTo = (n: number): number => {
    const weeks = Math.floor(n / 7);
    const rem = n - weeks * 7; // 0..6
    let count = weeks * perWeek + weekPrefix[rem]!;
    for (const h of holidayDays) {
      if (h >= 0 && h < n) count--; // holiday inside [0, n)
      else if (n <= h && h < 0) count++; // holiday inside [n, 0)
    }
    return count;
  };

  const countWorkingDays = (startDay: number, endDay: number): number =>
    endDay <= startDay ? 0 : workingDaysUpTo(endDay) - workingDaysUpTo(startDay);

  // ordinal(day) = working days strictly before `day`, which also equals the
  // ordinal of the next working day at/after `day` (the gap has no working days).
  const toOrdinal = (day: number): number => workingDaysUpTo(day);

  const fromOrdinal = (ordinal: number): number => {
    if (perWeek === 0) throw new Error("WorkCalendar has no working days");
    // No-holiday arithmetic guess; holidays only shift the true day later, so the
    // guess's ordinal is <= target. Step forward to the exact ordinal, then snap.
    const weeks = Math.floor(ordinal / perWeek);
    const rem = (((ordinal - weeks * perWeek) % perWeek) + perWeek) % perWeek;
    let day = weeks * 7 + workOffsets[rem]!;
    while (workingDaysUpTo(day) < ordinal) day++;
    return nextWorkingDay(day);
  };

  const addWorkingDays = (startDay: number, workingDays: number): number =>
    fromOrdinal(toOrdinal(startDay) + Math.trunc(workingDays));

  return {
    isWorkingDay,
    nextWorkingDay,
    countWorkingDays,
    addWorkingDays,
    toOrdinal,
    fromOrdinal,
  };
}
