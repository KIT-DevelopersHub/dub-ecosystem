// Shiori (イベントのしおり) block-editor model. Ported from HitoLink TabiBook's
// free block canvas: a palette of block types dropped onto a 4-column grid, each
// block choosing its own column span (1–4). Persistence is localStorage (demo /
// mock friendly, mirrors TabiBook), keyed by action id. No backend dependency.

export type ShioriBlockType =
  | "text"
  | "heading"
  | "checklist"
  | "image"
  | "calendar"
  | "timetable"
  | "map";

/** Column span on the 4-column canvas (1 = quarter width, 4 = full width). */
export type ColSpan = 1 | 2 | 3 | 4;

export interface ShioriBlockBase {
  id: string;
  type: ShioriBlockType;
  /** How many of the 4 grid columns this block occupies. */
  span: ColSpan;
}

export interface TextBlock extends ShioriBlockBase {
  type: "text";
  content: { text: string };
}

export interface HeadingBlock extends ShioriBlockBase {
  type: "heading";
  content: { text: string; level: 1 | 2 | 3 };
}

export interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
}
export interface ChecklistBlock extends ShioriBlockBase {
  type: "checklist";
  content: { items: ChecklistItem[] };
}

export interface ImageBlock extends ShioriBlockBase {
  type: "image";
  content: { url: string; caption?: string; alt?: string };
}

export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD
  label: string;
}
export interface CalendarBlock extends ShioriBlockBase {
  type: "calendar";
  content: { month: string; events: CalendarEvent[] }; // month = YYYY-MM
}

export interface TimetableSlot {
  id: string;
  time: string; // free-form short string, e.g. "10:30" or "Day1 10:30"
  label: string;
  location?: string;
}
export interface TimetableBlock extends ShioriBlockBase {
  type: "timetable";
  content: { day?: string; slots: TimetableSlot[] };
}

export interface MapBlock extends ShioriBlockBase {
  type: "map";
  content: { query: string; caption?: string };
}

export type ShioriBlock =
  | TextBlock
  | HeadingBlock
  | ChecklistBlock
  | ImageBlock
  | CalendarBlock
  | TimetableBlock
  | MapBlock;

export interface ShioriDoc {
  version: 1;
  blocks: ShioriBlock[];
  updatedAt: string;
}

export const GRID_COLS = 4 as const;

/** Default column span for a freshly-added block (tuned per type). */
export const DEFAULT_SPAN_BY_TYPE: Record<ShioriBlockType, ColSpan> = {
  text: 4,
  heading: 4,
  checklist: 2,
  image: 2,
  calendar: 4,
  timetable: 2,
  map: 2,
};

export function isShioriBlockType(v: unknown): v is ShioriBlockType {
  return (
    v === "text" ||
    v === "heading" ||
    v === "checklist" ||
    v === "image" ||
    v === "calendar" ||
    v === "timetable" ||
    v === "map"
  );
}
