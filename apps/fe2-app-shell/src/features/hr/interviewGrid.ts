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
  /** 自分は空き。others = 同じ時間に重なる他の人の枠 (空き・予約済みとも)。 */
  | { kind: "free"; others: hrInterview.InterviewSlot[] };

const overlaps = (s: hrInterview.InterviewSlot, startMs: number, endMs: number) =>
  Date.parse(s.startAt) < endMs && Date.parse(s.endAt) > startMs;

export function cellState(slots: readonly hrInterview.InterviewSlot[], meId: string, range: { startMs: number; endMs: number }, nowMs: number): CellState {
  const here = slots.filter((s) => overlaps(s, range.startMs, range.endMs));
  const mine = here.find((s) => s.interviewerId === meId);
  if (mine) return mine.applicantId ? { kind: "booked", slot: mine } : { kind: "mine", slot: mine };
  if (range.startMs <= nowMs) return { kind: "past" };
  return { kind: "free", others: here };
}

/** 名前の先頭 (苗字) だけ。マスが狭いので「田中 太郎」→「田中」。 */
const shortName = (name: string): string => name.trim().split(/\s+/u)[0] || "担当者";

/**
 * 他の人の枠をマスに出す文言。予約が入っていれば「担当: 応募者」を優先して薄い緑、空きだけなら名前を薄い青で。
 * 複数人は「田中・佐藤」、3 人以上は「田中 他 2」。title には全員分を出す。
 */
export function othersView(others: readonly hrInterview.InterviewSlot[]): { tone: "booked" | "open"; text: string; title: string } | null {
  if (others.length === 0) return null;
  const booked = others.filter((s) => s.applicantId !== null);
  const title = others
    .map((s) => `${s.interviewerName || "担当者"}（${s.applicantId ? `予約: ${s.applicantName ?? "応募者"}` : "空き"}）`)
    .join("\n");
  if (booked.length > 0) {
    const b = booked[0]!;
    const more = others.length > 1 ? ` 他 ${others.length - 1}` : "";
    return { tone: "booked", text: `${shortName(b.interviewerName)}: ${b.applicantName ?? "予約"}${more}`, title };
  }
  const names = [...new Set(others.map((s) => shortName(s.interviewerName)))];
  const text = names.length <= 2 ? names.join("・") : `${names[0]} 他 ${names.length - 1}`;
  return { tone: "open", text, title };
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
