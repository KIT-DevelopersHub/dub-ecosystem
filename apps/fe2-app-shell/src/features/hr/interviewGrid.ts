// 面談タブのコマ表の純粋なロジック (日本時間の週・コマ・ドラッグ範囲 → 足す/外す枠)。
// 人事は日本で運営しているので、ブラウザのタイムゾーンに関係なく日本時間で並べる。
import type { hrInterview } from "@dub/types";

const JST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

export const GRID_START_MIN = 9 * 60;
export const GRID_END_MIN = 21 * 60;
export const GRID_STEPS = [30, 60] as const;
export type GridStep = (typeof GRID_STEPS)[number];

/** 日本時間の日付 (その日 0:00 JST の UTC ms)。 */
export type JstDay = number;

export function jstDayOf(ms: number): JstDay {
  return Math.floor((ms + JST_MS) / DAY_MS) * DAY_MS - JST_MS;
}

/** その週の月曜 (日本時間)。 */
export function jstWeekStart(ms: number): JstDay {
  const day = jstDayOf(ms);
  const weekday = new Date(day + JST_MS).getUTCDay(); // 0 = 日
  return day - ((weekday + 6) % 7) * DAY_MS;
}

export function addDays(day: JstDay, n: number): JstDay {
  return day + n * DAY_MS;
}

const DAY_LABEL = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" });

export function dayLabel(day: JstDay): string {
  return DAY_LABEL.format(new Date(day)).replace(/\((.)\)/u, " ($1)");
}

export function timeLabel(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export interface Cell {
  day: number; // 0..6
  row: number;
}

export function rowCount(step: GridStep): number {
  return (GRID_END_MIN - GRID_START_MIN) / step;
}

export function cellRange(week: JstDay, step: GridStep, c: Cell): { startMs: number; endMs: number } {
  const startMs = addDays(week, c.day) + (GRID_START_MIN + c.row * step) * 60_000;
  return { startMs, endMs: startMs + step * 60_000 };
}

export type CellState =
  | { kind: "past" }
  | { kind: "booked"; slot: hrInterview.InterviewSlot }
  | { kind: "mine"; slot: hrInterview.InterviewSlot }
  | { kind: "free"; others: number };

const overlaps = (s: hrInterview.InterviewSlot, startMs: number, endMs: number) =>
  Date.parse(s.startAt) < endMs && Date.parse(s.endAt) > startMs;

export function cellState(slots: readonly hrInterview.InterviewSlot[], meId: string, range: { startMs: number; endMs: number }, nowMs: number): CellState {
  const here = slots.filter((s) => overlaps(s, range.startMs, range.endMs));
  const mine = here.find((s) => s.interviewerId === meId);
  if (mine) return mine.applicantId ? { kind: "booked", slot: mine } : { kind: "mine", slot: mine };
  if (range.startMs <= nowMs) return { kind: "past" };
  return { kind: "free", others: here.filter((s) => s.applicantId === null).length };
}

/** ドラッグの始点と今の位置で囲んだ長方形 (日 × 時間)。 */
export function cellsBetween(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
  for (let day = Math.min(a.day, b.day); day <= Math.max(a.day, b.day); day++) {
    for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) out.push({ day, row });
  }
  return out;
}

export type DragMode = "add" | "remove";

/** 始点のコマで決まる: 空きなら足す、自分の枠なら外す、それ以外 (過去・予約済み) は何もしない。 */
export function modeFor(state: CellState): DragMode | null {
  if (state.kind === "free") return "add";
  if (state.kind === "mine") return "remove";
  return null;
}

export function planChange(
  mode: DragMode,
  cells: readonly Cell[],
  stateOf: (c: Cell) => CellState,
  rangeOf: (c: Cell) => { startMs: number; endMs: number },
  step: GridStep,
): { add: hrInterview.NewInterviewSlot[]; remove: string[] } {
  if (mode === "add") {
    const add = cells
      .filter((c) => stateOf(c).kind === "free")
      .map((c) => ({ startAt: new Date(rangeOf(c).startMs).toISOString(), durationMinutes: step }));
    return { add, remove: [] };
  }
  const ids = new Set<string>();
  for (const c of cells) {
    const s = stateOf(c);
    if (s.kind === "mine") ids.add(s.slot.id);
  }
  return { add: [], remove: [...ids] };
}
