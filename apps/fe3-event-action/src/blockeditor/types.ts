// Generic block-editor model. Extracted/generalised from the "しおり" (event
// booklet) editor so the same widget-canvas UI can drive BOTH the shiori action
// panel AND the event-page inline editor. A palette of block types dropped onto a
// 4-column grid, each block choosing its own column span (1–4). Persistence is
// caller-supplied (localStorage keyed by any string — action id, event id, …), so
// this module carries no knowledge of events or actions.

export type BlockType =
  | "text"
  | "heading"
  | "checklist"
  | "image"
  | "calendar"
  | "timetable"
  | "map";

/** Column span on the 4-column canvas (1 = quarter width, 4 = full width). */
export type ColSpan = 1 | 2 | 3 | 4;

export interface BlockBase {
  id: string;
  type: BlockType;
  /** How many of the 4 grid columns this block occupies. */
  span: ColSpan;
}

export interface TextBlock extends BlockBase {
  type: "text";
  content: { text: string };
}

export interface HeadingBlock extends BlockBase {
  type: "heading";
  content: { text: string; level: 1 | 2 | 3 };
}

export interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
}
export interface ChecklistBlock extends BlockBase {
  type: "checklist";
  content: { items: ChecklistItem[] };
}

export interface ImageBlock extends BlockBase {
  type: "image";
  content: { url: string; caption?: string; alt?: string };
}

export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD
  label: string;
}
export interface CalendarBlock extends BlockBase {
  type: "calendar";
  content: { month: string; events: CalendarEvent[] }; // month = YYYY-MM
}

export interface TimetableSlot {
  id: string;
  time: string; // free-form short string, e.g. "10:30" or "Day1 10:30"
  label: string;
  location?: string;
}
export interface TimetableBlock extends BlockBase {
  type: "timetable";
  content: { day?: string; slots: TimetableSlot[] };
}

export interface MapBlock extends BlockBase {
  type: "map";
  content: { query: string; caption?: string };
}

export type Block =
  | TextBlock
  | HeadingBlock
  | ChecklistBlock
  | ImageBlock
  | CalendarBlock
  | TimetableBlock
  | MapBlock;

export interface BlockDoc {
  version: 1;
  blocks: Block[];
  updatedAt: string;
}

export const GRID_COLS = 4 as const;

/** Default column span for a freshly-added block (tuned per type). */
export const DEFAULT_SPAN_BY_TYPE: Record<BlockType, ColSpan> = {
  text: 4,
  heading: 4,
  checklist: 2,
  image: 2,
  calendar: 4,
  timetable: 2,
  map: 2,
};

export function isBlockType(v: unknown): v is BlockType {
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
